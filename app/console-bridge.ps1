# Console bridge for the Claude panel (one long-lived hidden powershell, driven line by line over stdin/stdout).
#   anc <pid>             -> "ok <pid>:<name>|<pid>:<name>|..."  the process and its ancestors (Toolhelp snapshot)
#   alive <pid>           -> "ok 1" | "ok 0"
#   send <pid> <base64>   -> "ok" | "err <reason>"   types UTF-8 text, then Enter, into the console <pid> is attached to
#   key <pid> <name>      -> "ok" | "err <reason>"   one key: up down left right enter esc tab btab (Shift+Tab) bksp,
#                                                   ctrl<letter> (Ctrl+A ... as Claude Code's menus name them),
#                                                   clear (Claude Code's input box emptied: Ctrl+E Ctrl+U, then
#                                                   Backspace Ctrl+U for the lines above; Ctrl+Y there brings it back)
#   type <pid> <b64>      -> as send, without the Enter (tests)
#   screen <pid> [hl]     -> "ok <base64>" | "err <reason>"   the visible text of that console window (UTF-8);
#                                                   hl: what is highlighted (a menu's current tab) between U+E000 / U+E001
#   launch <base64 json>  -> "ok <pid>" | "err <reason>"   {exe, args, cwd}: start a program in a new console window
# Input goes through WriteConsoleInput, i.e. the terminal's own input buffer: Claude Code reads it exactly like
# keystrokes. Nothing global is simulated (no SendInput), so whatever window has the focus is never touched.
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AmeCon {
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int KeyDown;
    [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort VK;
    [FieldOffset(12)] public ushort Scan;
    [FieldOffset(14)] public ushort Ch;          // ushort, not char: a char field is marshalled as ANSI
    [FieldOffset(16)] public uint Ctrl;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint n, out uint written);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint mapType);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr h, ref PROCESSENTRY32W e);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr h, ref PROCESSENTRY32W e);

  static Dictionary<uint, KeyValuePair<uint, string>> Snapshot() {
    var d = new Dictionary<uint, KeyValuePair<uint, string>>();
    IntPtr h = CreateToolhelp32Snapshot(2, 0);
    if (h == (IntPtr)(-1)) return d;
    var e = new PROCESSENTRY32W(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
    if (Process32FirstW(h, ref e)) do { d[e.th32ProcessID] = new KeyValuePair<uint, string>(e.th32ParentProcessID, e.szExeFile); } while (Process32NextW(h, ref e));
    CloseHandle(h);
    return d;
  }
  public static string Ancestors(uint pid) {
    var d = Snapshot(); var sb = new StringBuilder(); var seen = new HashSet<uint>();
    while (pid != 0 && d.ContainsKey(pid) && seen.Add(pid) && seen.Count <= 12) {
      if (sb.Length > 0) sb.Append('|');
      sb.Append(pid).Append(':').Append(d[pid].Value);
      pid = d[pid].Key;
    }
    return sb.ToString();
  }
  public static bool Alive(uint pid) { return Snapshot().ContainsKey(pid); }

  // attach to the console of pid, run fn on its input buffer (CONIN$), always detach again
  delegate string ConFn(IntPtr h);
  static string WithConsole(uint pid, string dev, ConFn fn) {
    FreeConsole();
    if (!AttachConsole(pid)) return "!attach " + Marshal.GetLastWin32Error();
    IntPtr h = CreateFileW(dev, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    if (h == (IntPtr)(-1)) { int e = Marshal.GetLastWin32Error(); FreeConsole(); return "!open " + e; }
    try { return fn(h); } finally { CloseHandle(h); FreeConsole(); }
  }

  static void Key(List<INPUT_RECORD> l, ushort ch, ushort vk, ushort scan, uint ctrl = 0) {
    foreach (int down in new[] { 1, 0 }) {
      var r = new INPUT_RECORD(); r.EventType = 1; r.KeyDown = down; r.Repeat = 1; r.VK = vk; r.Scan = scan; r.Ch = ch; r.Ctrl = ctrl;
      l.Add(r);
    }
  }
  static string Write(IntPtr h, List<INPUT_RECORD> l) {
    var a = l.ToArray(); uint off = 0;
    while (off < a.Length) {                                   // the input buffer takes it in slices
      uint n = (uint)Math.Min(512, a.Length - off), w;
      var part = new INPUT_RECORD[n]; Array.Copy(a, off, part, 0, n);
      if (!WriteConsoleInputW(h, part, n, out w)) return "!write " + Marshal.GetLastWin32Error();
      off += w == 0 ? n : w;
    }
    return null;
  }
  public static string Send(uint pid, string text, bool enter) {
    return WithConsole(pid, "CONIN$", h => {
      var l = new List<INPUT_RECORD>();
      bool multi = text.IndexOf('\n') >= 0;
      if (multi) foreach (char c in "\x1b[200~") Key(l, c, 0, 0);   // bracketed paste: newlines stay newlines
      foreach (char c in text.Replace("\r\n", "\n")) Key(l, c, 0, 0);
      if (multi) foreach (char c in "\x1b[201~") Key(l, c, 0, 0);
      string err = Write(h, l);
      if (err != null || !enter) return err;
      // Enter on its own, a moment later: an Enter inside a fast burst is taken as part of a paste (a newline)
      Thread.Sleep(Math.Min(900, 250 + text.Length / 4));
      var e = new List<INPUT_RECORD>(); Key(e, '\r', 0x0D, 0x1C);
      return Write(h, e);
    });
  }
  // the visible text of a console window (to see a prompt in a session this app started, e.g. folder trust)
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD Size, Cursor; public ushort Attr; public SMALL_RECT Window; public COORD MaxSize; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD at, out uint read);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadConsoleOutputAttribute(IntPtr h, [Out] ushort[] attrs, uint len, COORD at, out uint read);
  // the background a cell is drawn with (0x4000: reverse video -- then it is the foreground's colour)
  static int Back(ushort a) { return (a & 0x4000) != 0 ? (a & 0xF) : ((a >> 4) & 0xF); }
  // hl: what is drawn on another background than most of the screen (the tab a menu is on, a selection) is put
  // between U+E000 and U+E001 -- the text alone does not say which of "Status  Config  Usage" is the current one
  public static string Screen(uint pid, bool hl) {
    return WithConsole(pid, "CONOUT$", h => {
      CSBI info;
      if (!GetConsoleScreenBufferInfo(h, out info)) return "!info " + Marshal.GetLastWin32Error();
      var sb = new StringBuilder();
      int w = info.Window.Right - info.Window.Left + 1, rows = info.Window.Bottom - info.Window.Top + 1;
      var text = new string[rows]; var attr = new ushort[rows][]; var seen = new int[16];
      for (int r = 0; r < rows; r++) {
        var line = new StringBuilder(w); uint got;
        var at = new COORD(); at.X = info.Window.Left; at.Y = (short)(info.Window.Top + r);
        text[r] = ReadConsoleOutputCharacterW(h, line, (uint)w, at, out got) ? line.ToString(0, (int)Math.Min(got, (uint)line.Length)).TrimEnd() : null;
        if (!hl) continue;
        var a = new ushort[w]; uint n;
        if (!ReadConsoleOutputAttribute(h, a, (uint)w, at, out n)) continue;
        attr[r] = a;
        for (int x = 0; x < n; x++) seen[Back(a[x])]++;
      }
      int usual = 0;
      for (int i = 1; i < 16; i++) if (seen[i] > seen[usual]) usual = i;
      for (int r = 0; r < rows; r++) {
        if (text[r] == null) continue;
        if (attr[r] == null) { sb.Append(text[r]).Append('\n'); continue; }
        // a wide character (CJK) is one character over two cells: the second cell is flagged (0x0200) and skipped
        int cell = 0; bool on = false;
        foreach (char c in text[r]) {
          while (cell < w && (attr[r][cell] & 0x0200) != 0) cell++;
          bool m = cell < w && Back(attr[r][cell]) != usual;
          if (m != on) { sb.Append(m ? '\uE000' : '\uE001'); on = m; }
          sb.Append(c); cell++;
        }
        if (on) sb.Append('\uE001');
        sb.Append('\n');
      }
      return "=" + sb.ToString();
    });
  }
  // one navigation key (for the terminal's own menus: /model, /resume, prompts): up down left right enter esc tab,
  // btab = Shift+Tab (Claude Code: cycle the permission mode); Claude Code's Ctrl combinations: ctrlb (the running
  // command to the background), ctrls (stash the draft), ctrlxs = Ctrl+X Ctrl+S (send what is queued now)
  public static string KeyPress(uint pid, string name) {
    ushort vk, scan, ch = 0; uint ctrl = 0;
    if (name == "clear") return ClearInput(pid);
    if (name == "ctrlb" || name == "ctrls" || name == "ctrlxs") return WithConsole(pid, "CONIN$", h => {
      var l = new List<INPUT_RECORD>();                                        // (0x0008: LEFT_CTRL_PRESSED)
      if (name == "ctrlb") Key(l, 2, 0x42, 0x30, 0x0008);
      if (name == "ctrlxs") Key(l, 24, 0x58, 0x2D, 0x0008);
      if (name != "ctrlb") Key(l, 19, 0x53, 0x1F, 0x0008);
      return Write(h, l);
    });
    // any other Ctrl+letter a menu names (ctrla ... ctrly; the caller never asks for C, D or Z)
    if (name.Length == 5 && name.StartsWith("ctrl") && name[4] >= 'a' && name[4] <= 'z') return WithConsole(pid, "CONIN$", h => {
      var l = new List<INPUT_RECORD>(); char c = name[4];
      Key(l, (ushort)(c - 96), (ushort)(c - 32), (ushort)MapVirtualKeyW((uint)(c - 32), 0), 0x0008);
      return Write(h, l);
    });
    switch (name) {
      case "bksp": vk = 0x08; scan = 0x0E; ch = 8; break;
      case "btab": vk = 0x09; scan = 0x0F; ch = 9; ctrl = 0x0010; break;   // SHIFT_PRESSED
      case "up": vk = 0x26; scan = 0x48; break;
      case "down": vk = 0x28; scan = 0x50; break;
      case "left": vk = 0x25; scan = 0x4B; break;
      case "right": vk = 0x27; scan = 0x4D; break;
      case "enter": vk = 0x0D; scan = 0x1C; ch = 13; break;
      case "esc": vk = 0x1B; scan = 0x01; ch = 27; break;
      case "tab": vk = 0x09; scan = 0x0F; ch = 9; break;
      default: return "!unknown key";
    }
    return WithConsole(pid, "CONIN$", h => { var l = new List<INPUT_RECORD>(); Key(l, ch, vk, scan, ctrl); return Write(h, l); });
  }
  // empty Claude Code's input box (what was typed there must not be sent along with a reply from the dashboard)
  public static string ClearInput(uint pid) {
    return WithConsole(pid, "CONIN$", h => {
      var l = new List<INPUT_RECORD>();
      Key(l, 5, 0x45, 0x12, 0x0008); Key(l, 21, 0x55, 0x16, 0x0008);           // Ctrl+E, Ctrl+U
      for (int i = 0; i < 20; i++) { Key(l, 8, 0x08, 0x0E); Key(l, 21, 0x55, 0x16, 0x0008); }   // Backspace, Ctrl+U
      return Write(h, l);
    });
  }
}
'@

$out = [Console]::Out
$res = { param($e) if ($e) { 'err ' + $e.TrimStart('!') } else { 'ok' } }
$out.WriteLine('ready'); $out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $p = $line.Split(' ')
  try {
    switch ($p[0]) {
      'anc'    { $r = 'ok ' + [AmeCon]::Ancestors([uint32]$p[1]) }
      'alive'  { $r = 'ok ' + [int][AmeCon]::Alive([uint32]$p[1]) }
      'screen' { $t = [AmeCon]::Screen([uint32]$p[1], ($p.Length -gt 2 -and $p[2] -eq 'hl')); if ($t.StartsWith('=')) { $r = 'ok ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t.Substring(1))) } else { $r = 'err ' + $t.TrimStart('!') } }
      'launch' {
        $j = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[1])) | ConvertFrom-Json
        $si = New-Object Diagnostics.ProcessStartInfo
        $si.FileName = $j.exe; $si.Arguments = $j.args; $si.WorkingDirectory = $j.cwd; $si.UseShellExecute = $true   # its own console window
        $r = 'ok ' + [Diagnostics.Process]::Start($si).Id
      }
      'key'    { $r = & $res ([AmeCon]::KeyPress([uint32]$p[1], [string]$p[2])) }
      'send'   { $r = & $res ([AmeCon]::Send([uint32]$p[1], [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])), $true)) }
      'type'   { $r = & $res ([AmeCon]::Send([uint32]$p[1], [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])), $false)) }
      default  { $r = 'err unknown' }
    }
  } catch { $r = 'err ' + ($_.Exception.Message -replace '\s+', ' ') }
  $out.WriteLine($r); $out.Flush()
}

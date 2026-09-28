# Console bridge for the Claude panel (one long-lived hidden powershell, driven line by line over stdin/stdout).
#   anc <pid>             -> "ok <pid>:<name>|<pid>:<name>|..."  the process and its ancestors (Toolhelp snapshot)
#   alive <pid>           -> "ok 1" | "ok 0"
#   send <pid> <base64>   -> "ok" | "err <reason>"   types UTF-8 text, then Enter, into the console <pid> is attached to
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

  static void Key(List<INPUT_RECORD> l, ushort ch, ushort vk, ushort scan) {
    foreach (int down in new[] { 1, 0 }) {
      var r = new INPUT_RECORD(); r.EventType = 1; r.KeyDown = down; r.Repeat = 1; r.VK = vk; r.Scan = scan; r.Ch = ch;
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
      'send'   { $r = & $res ([AmeCon]::Send([uint32]$p[1], [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p[2])), $true)) }
      default  { $r = 'err unknown' }
    }
  } catch { $r = 'err ' + ($_.Exception.Message -replace '\s+', ' ') }
  $out.WriteLine($r); $out.Flush()
}

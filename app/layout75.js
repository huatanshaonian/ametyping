// User's keyboard: GravaStar Pro series 75% (from the photo, 2026-09-27), NGO-themed keycaps.
// Each entry: [label, widthU, uiohookKeycode, color, dyU?]; label null = gap. The rotary knob sits at the top right.
// color: w white, p pink, m mint, c clear cyan, r red (NGO spacebar), d dark red, g dark green, k knob
window.LAYOUT75 = [
  [['Esc',1,1,'p'],[null,0.5],['F1',1,59,'c'],['F2',1,60,'p'],['F3',1,61,'p'],['F4',1,62,'p'],[null,0.5],
   ['F5',1,63,'m'],['F6',1,64,'m'],['F7',1,65,'m'],['F8',1,66,'d'],[null,0.5],
   ['F9',1,67,'p'],['F10',1,68,'w'],['F11',1,87,'p'],['F12',1,88,'w'],[null,0.25],['Knob',1.25,57392,'k']],
  [['`',1,41,'m'],['1',1,2,'m'],['2',1,3,'p'],['3',1,4,'p'],['4',1,5,'p'],['5',1,6,'p'],['6',1,7,'p'],
   ['7',1,8,'w'],['8',1,9,'w'],['9',1,10,'w'],['0',1,11,'w'],['-',1,12,'w'],['=',1,13,'w'],
   ['Bksp',2,14,'c'],['Del',1,3667,'w']],
  [['Tab',1.5,15,'w'],['Q',1,16,'w'],['W',1,17,'p'],['E',1,18,'p'],['R',1,19,'p'],['T',1,20,'p'],
   ['Y',1,21,'p'],['U',1,22,'w'],['I',1,23,'w'],['O',1,24,'w'],['P',1,25,'w'],['[',1,26,'w'],[']',1,27,'w'],
   ['\\',1.5,43,'m'],['PgUp',1,3657,'w']],
  [['Caps',1.75,58,'c'],['A',1,30,'w'],['S',1,31,'p'],['D',1,32,'p'],['F',1,33,'p'],['G',1,34,'p'],
   ['H',1,35,'p'],['J',1,36,'w'],['K',1,37,'w'],['L',1,38,'w'],[';',1,39,'w'],["'",1,40,'w'],
   ['Enter',2.25,28,'p'],['PgDn',1,3665,'p']],
  [['Shift',2.25,42,'w'],['Z',1,44,'w'],['X',1,45,'p'],['C',1,46,'p'],['V',1,47,'p'],['B',1,48,'p'],
   ['N',1,49,'p'],['M',1,50,'w'],[',',1,51,'w'],['.',1,52,'w'],['/',1,53,'w'],
   ['RShift',1.75,54,'w'],['Up',1,57416,'p',0.2],['End',1,3663,'g']],
  [['Ctrl',1.25,29,'p'],['Win',1.25,3675,'p'],['Alt',1.25,56,'m'],['Space',6.25,57,'r'],
   ['RAlt',1.25,3640,'m'],['Fn',1.25,null,'p'],[null,0.5],
   ['Left',1,57419,'p',0.2],['Down',1,57424,'p',0.2],['Right',1,57421,'p',0.2]],
];
// Keys that report different codes -> alias to a layout keycode.
// The knob sends volume up / down / mute; all of them land on the knob.
window.KEY_ALIASES = { 3676: 3675 /* right Win */, 3612: 28 /* numpad Enter */, 3613: 29 /* right Ctrl */,
  57390: 57392 /* volume down */, 57376: 57392 /* mute */ };
window.KNOB_DIR = { 57392: 1, 57390: -1, 57376: 0 };
// Where each hand rests when idle (S and L: a relaxed, wide stance for the big hands)
window.REST_KEYS = { L: 31 /* S */, R: 38 /* L */ };

// 画板's toolbar icons: line drawings on a 24 x 24 grid, in the button's own text colour (so they follow the theme
// and a pressed button's inverted colours). icon(name) -> an <svg> element.
const NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  pencil: 'M4 20l1.2-4.6L16.5 4.1a1.6 1.6 0 012.3 0l1.1 1.1a1.6 1.6 0 010 2.3L8.6 18.8z M14.5 6.1l3.4 3.4 M5.2 15.4l3.4 3.4',
  marker: 'M14.2 3.5l6.3 6.3-8.6 8.6H7.6l-2-2v-4.3z M5.6 16.4L3 19h4.6 M10.8 6.9l6.3 6.3 M13 21h8',
  eraser: 'M14.5 4.2l5.3 5.3a1.6 1.6 0 010 2.3L12 19.6H8L4.2 15.8a1.6 1.6 0 010-2.3l8-9.3a1.6 1.6 0 012.3 0z M8.4 9.6l6 6 M12 19.6h8',
  hand: 'M12 3v18 M3 12h18 M12 3l-2.6 2.6 M12 3l2.6 2.6 M12 21l-2.6-2.6 M12 21l2.6-2.6 M3 12l2.6-2.6 M3 12l2.6 2.6 M21 12l-2.6-2.6 M21 12l-2.6 2.6',
  lasso: 'M12 3.5c4.7 0 8.5 2.5 8.5 5.6s-3.800 5.600-8.500 5.600c-1 0-2-.1-2.9-.3 M6.300 13.200C4.600 12.200 3.500 10.700 3.500 9.100 3.500 6 7.300 3.500 12 3.500 M7 13.500a2 2 0 110 4 2 2 0 010-4z M7 17.500c0 2-1 3.300-3 3.500',
  undo: 'M8.500 5.500L4 10l4.500 4.500 M4 10h10.500a5 5 0 010 10H9',
  redo: 'M15.500 5.500L20 10l-4.500 4.500 M20 10H9.500a5 5 0 000 10H15',
  clear: 'M4 7h16 M9.500 7V4.200h5V7 M6 7l1 13h10l1-13 M10 11v5.500 M14 11v5.500',
  zoomOut: 'M10.500 4a6.500 6.500 0 110 13 6.500 6.500 0 010-13z M15.300 15.300L20.500 20.500 M7.800 10.500h5.400',
  zoomIn: 'M10.500 4a6.500 6.500 0 110 13 6.500 6.500 0 010-13z M15.300 15.300L20.500 20.500 M7.800 10.500h5.400 M10.500 7.800v5.400',
  finger: 'M9 13.500V5.200a1.600 1.600 0 013.200 0v5.300 M12.200 10.500V9.300a1.600 1.600 0 013.200 0v1.900 M15.400 11.200v-.6a1.600 1.600 0 013.200 0v4.900c0 3.300-2.300 5.500-5.400 5.500h-1c-1.800 0-3.100-.7-4.100-2.100l-3-4.300c-.9-1.300.8-2.700 2-1.600L9 15',
  add: 'M6 3h8.5L19 7.5V21H6z M12 10.5v6 M9 13.5h6',
  rename: 'M9 4.500h6 M12 4.500v15 M9 19.500h6',
  trash: 'M6 3h8.5L19 7.5V21H6z M9.5 11.5l5 5 M14.5 11.5l-5 5',
  ai: 'M11 3.500l2 5.500 5.500 2-5.500 2-2 5.500-2-5.500-5.500-2 5.500-2z M18.500 14.500l.9 2.100 2.100.9-2.100.9-.9 2.100-.9-2.100-2.100-.9 2.100-.9z',
  result: 'M6 3h8.500L19 7.500V21H6z M14.500 3v4.500H19 M9 12h7 M9 16h7',
  image: 'M4 5h16v14H4z M4 15.500l4.500-4.500 4 4 2.500-2.500 5 5 M15 9.300a.9.9 0 110 .01',
};

export function icon(name) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'bd-ico'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', PATHS[name] || '');
  svg.append(p);
  return svg;
}

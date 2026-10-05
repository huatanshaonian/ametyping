// 显示属性's part for 色调, 自动切换 and 夜灯 (js/shade.js): the rows shown depend on what is chosen -- the night's
// shade and the place or the hours only when 自动切换 is on, the strength only when 夜灯 is.
import { h } from './util.js';
import * as shade from './shade.js';
import { CITIES } from './sun.js';

export function panel() {
  const root = h('div', { class: 'shadebar' });
  const opt = (list, cur) => list.map(([v, l]) => h('option', { value: v, text: l, selected: v === cur }));
  function render() {
    const s = shade.get(), list = shade.SHADES[s.look];
    const day = h('select', { class: 'field', id: 'sh-day', title: '平时（白天）用的色调' }, ...opt(list, s.day));
    day.addEventListener('change', () => { shade.set({ day: day.value }); render(); });
    const auto = h('select', { class: 'field', id: 'sh-auto', title: '到了晚上自动换成另一种色调' }, ...opt(shade.AUTOS, s.auto));
    auto.addEventListener('change', () => { shade.set({ auto: auto.value }); render(); });
    const rows = [h('span', { text: '色调：' }), day, h('span', { text: '自动切换：' }), auto];
    if (s.auto !== 'off') {
      const night = h('select', { class: 'field', id: 'sh-night', title: '夜间用的色调' }, ...opt(list, s.night));
      night.addEventListener('change', () => { shade.set({ night: night.value }); render(); });
      rows.push(h('span', { text: '夜间色调：' }), night);
    }
    if (s.auto === 'sun') {
      // a city, or coordinates of your own (north and east positive)
      const at = CITIES.find((c) => c[0] === s.place.name);           // (no name: coordinates of your own)
      const city = h('select', { class: 'field', id: 'sh-city', title: '按哪里的日出日落' }, ...CITIES.map((c) => h('option', { value: c[0], text: c[0], selected: at === c })),
        h('option', { value: '', text: '自己填经纬度', selected: !at }));
      const lat = h('input', { class: 'field shn', id: 'sh-lat', type: 'number', step: '0.1', min: '-90', max: '90', value: s.place.lat, title: '纬度（北纬为正）' });
      const lon = h('input', { class: 'field shn', id: 'sh-lon', type: 'number', step: '0.1', min: '-180', max: '180', value: s.place.lon, title: '经度（东经为正）' });
      city.addEventListener('change', () => { const c = CITIES.find((x) => x[0] === city.value); shade.set({ place: c ? { lat: c[1], lon: c[2], name: c[0] } : { lat: s.place.lat, lon: s.place.lon, name: '' } }); render(); });
      const typed = () => { if (lat.value !== '' && lon.value !== '') { shade.set({ place: { lat: +lat.value, lon: +lon.value, name: '' } }); render(); } };
      lat.addEventListener('change', typed); lon.addEventListener('change', typed);
      rows.push(h('span', { text: '地点：' }), city);
      if (!at) rows.push(h('span', { text: '纬度' }), lat, h('span', { text: '经度' }), lon);
      rows.push(h('span', { class: 'shh', id: 'sh-sun', text: shade.sunText(s) + (shade.isNight(s) ? '（现在是夜间）' : '（现在是白天）') }));
    }
    if (s.auto === 'clock') {
      const from = h('input', { class: 'field', id: 'sh-from', type: 'time', value: s.clock.from, title: '夜间从几点开始' });
      const to = h('input', { class: 'field', id: 'sh-to', type: 'time', value: s.clock.to, title: '夜间到几点结束' });
      from.addEventListener('change', () => { if (from.value) { shade.set({ clock: { from: from.value } }); render(); } });
      to.addEventListener('change', () => { if (to.value) { shade.set({ clock: { to: to.value } }); render(); } });
      rows.push(h('span', { text: '夜间：' }), from, h('span', { text: '到' }), to, h('span', { class: 'shh', text: shade.isNight(s) ? '（现在是夜间）' : '（现在是白天）' }));
    }
    // 夜灯: 只在夜间 needs a night, so it is offered when 自动切换 is on
    const lights = shade.LIGHTS.filter(([v]) => v !== 'night' || s.auto !== 'off' || s.light === 'night');
    const light = h('select', { class: 'field', id: 'sh-light', title: '夜灯：整个页面加一层暖色并略微调暗（不改颜色）' }, ...opt(lights, s.light));
    light.addEventListener('change', () => { shade.set({ light: light.value }); render(); });
    rows.push(h('span', { class: 'shbr' }), h('span', { text: '夜灯：' }), light);
    if (s.light !== 'off') {
      const level = h('input', { id: 'sh-level', type: 'range', min: '10', max: '100', step: '5', value: Math.round(s.level * 100), title: '夜灯的强度' });
      level.addEventListener('input', () => shade.set({ level: level.value / 100 }));
      rows.push(h('span', { text: '强度' }), level);
      if (s.light === 'night' && s.auto === 'off') rows.push(h('span', { class: 'shh', text: '（自动切换是关闭的：夜灯不会亮）' }));
    }
    root.replaceChildren(...rows);
  }
  render();
  // dusk or dawn came while the window is open: the note about day / night follows
  const off = shade.onChange(() => { if (root.isConnected) render(); else off(); });
  return { root, render };
}

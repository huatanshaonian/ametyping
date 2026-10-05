// Sunrise and sunset of a day at a place, worked out from the date and the coordinates alone (the "sunrise equation";
// good to a couple of minutes, which is plenty for switching colours). Nothing is looked up anywhere.
const RAD = Math.PI / 180, DAY = 86400000, J1970 = 2440587.5, J2000 = 2451545;

// day: any moment of the local day wanted; lat north positive, lon east positive.
// -> { rise, set } (ms), or { polar: 'night' | 'day' } where the sun does not rise / set that day
export function sunTimes(day, lat, lon) {
  const d = new Date(day);
  const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
  const n = Math.round(noon / DAY + J1970 - J2000 + lon / 360);
  const js = n - lon / 360;                                   // mean solar noon, in days since J2000
  const M = (357.5291 + 0.98560028 * js) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = (M + C + 180 + 102.9372) % 360;                   // ecliptic longitude
  const transit = J2000 + js + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
  const sinD = Math.sin(L * RAD) * Math.sin(23.4397 * RAD), cosD = Math.cos(Math.asin(sinD));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinD) / (Math.cos(lat * RAD) * cosD);
  if (cosW > 1) return { polar: 'night' };
  if (cosW < -1) return { polar: 'day' };
  const w = Math.acos(cosW) / RAD / 360;
  const ms = (j) => Math.round((j - J1970) * DAY);
  return { rise: ms(transit - w), set: ms(transit + w) };
}

// is it night there at that moment (before sunrise or after sunset)?
export function isNightAt(now, lat, lon) {
  const t = sunTimes(now, lat, lon);
  if (t.polar) return t.polar === 'night';
  return now < t.rise || now >= t.set;
}

// a few places to pick from (the coordinates can also be typed in): [name, lat, lon]
export const CITIES = [['北京', 39.9, 116.4], ['上海', 31.2, 121.5], ['广州', 23.1, 113.3], ['深圳', 22.5, 114.1], ['成都', 30.7, 104.1], ['重庆', 29.6, 106.5],
  ['武汉', 30.6, 114.3], ['西安', 34.3, 108.9], ['南京', 32.1, 118.8], ['杭州', 30.3, 120.2], ['长沙', 28.2, 112.9], ['沈阳', 41.8, 123.4], ['哈尔滨', 45.8, 126.5],
  ['昆明', 25.0, 102.7], ['兰州', 36.1, 103.8], ['乌鲁木齐', 43.8, 87.6], ['拉萨', 29.7, 91.1], ['香港', 22.3, 114.2], ['台北', 25.0, 121.5],
  ['东京', 35.7, 139.7], ['新加坡', 1.35, 103.8], ['伦敦', 51.5, -0.1], ['纽约', 40.7, -74.0], ['旧金山', 37.8, -122.4]];

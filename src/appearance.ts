import { Baby, Bath, BedDouble, BedSingle, BookOpen, CookingPot, House, ShowerHead, Sofa, UtensilsCrossed } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ClimateDevice, LightDevice } from './types';

const roomIcons: Record<string, LucideIcon> = {
  living: Sofa,
  dining: UtensilsCrossed,
  master: BedDouble,
  child: Baby,
  second: BedSingle,
  mainbath: Bath,
  bath: ShowerHead,
  kitchen: CookingPot,
  study: BookOpen,
};

/** HA 区域没有固定 id，按区域名称里的关键词选图标。 */
const roomKeywords: [string, LucideIcon][] = [
  ['客厅', Sofa],
  ['餐厅', UtensilsCrossed],
  ['主卧', BedDouble],
  ['儿童', Baby],
  ['次卧', BedSingle],
  ['卧', BedSingle],
  ['主卫', Bath],
  ['卫', ShowerHead],
  ['浴', ShowerHead],
  ['厨', CookingPot],
  ['书房', BookOpen],
];

export function roomIcon(room: { id: string; name: string }): LucideIcon {
  return roomIcons[room.id] ?? roomKeywords.find(([keyword]) => room.name.includes(keyword))?.[1] ?? House;
}

export type RoomSceneKind = 'living' | 'dining' | 'bedroom' | 'kids' | 'bath' | 'kitchen' | 'study' | 'home';

const roomScenes: Record<string, RoomSceneKind> = {
  living: 'living', dining: 'dining', master: 'bedroom', second: 'bedroom', child: 'kids',
  mainbath: 'bath', bath: 'bath', kitchen: 'kitchen', study: 'study',
};

/** 房间页页头的线描场景：演示数据按房间 id，HA 区域按名称关键词（儿童优先于卧室）。 */
const sceneKeywords: [string, RoomSceneKind][] = [
  ['客厅', 'living'], ['起居', 'living'],
  ['餐', 'dining'],
  ['儿童', 'kids'], ['孩子', 'kids'], ['宝宝', 'kids'],
  ['卧', 'bedroom'],
  ['卫', 'bath'], ['浴', 'bath'], ['洗手间', 'bath'],
  ['厨', 'kitchen'],
  ['书房', 'study'], ['办公', 'study'], ['工作', 'study'],
];

export function roomScene(room: { id: string; name: string }): RoomSceneKind {
  return roomScenes[room.id] ?? sceneKeywords.find(([keyword]) => room.name.includes(keyword))?.[1] ?? 'home';
}

const kelvinStops: [number, [number, number, number]][] = [
  [2700, [255, 172, 92]],
  [3500, [255, 204, 140]],
  [4500, [255, 232, 200]],
  [5500, [236, 240, 255]],
  [6500, [196, 220, 255]],
];

function kelvinToRgb(kelvin: number): [number, number, number] {
  if (kelvin <= kelvinStops[0][0]) return kelvinStops[0][1];
  for (let index = 1; index < kelvinStops.length; index += 1) {
    const [upper, upperColor] = kelvinStops[index];
    const [lower, lowerColor] = kelvinStops[index - 1];
    if (kelvin <= upper) {
      const ratio = (kelvin - lower) / (upper - lower);
      return lowerColor.map((part, channel) => Math.round(part + (upperColor[channel] - part) * ratio)) as [number, number, number];
    }
  }
  return kelvinStops[kelvinStops.length - 1][1];
}

/** 灯卡开启时的光晕色：彩色模式用当前颜色，色温模式按开尔文近似，仅开关灯用默认暖光。 */
export function lightGlow(light: LightDevice): string {
  const mode = light.activeColorMode ?? (light.color ? 'color' : 'color_temp');
  if (mode === 'color' && light.color) return light.color;
  if (light.colorTemp !== undefined && light.supportedColorModes.includes('color_temp')) {
    const [red, green, blue] = kelvinToRgb(light.colorTemp);
    return `rgb(${red} ${green} ${blue})`;
  }
  return '#ffc27a';
}

export type ClimateTone = 'off' | 'cool' | 'heat' | 'dry' | 'fan' | 'auto' | 'unavailable';

export function climateTone(device: ClimateDevice): ClimateTone {
  if (!device.available) return 'unavailable';
  if (!device.on) return 'off';
  if (device.kind === 'heating' || device.mode === 'heat') return 'heat';
  if (device.mode === 'cool') return 'cool';
  if (device.mode === 'dry') return 'dry';
  if (device.mode === 'fan_only') return 'fan';
  return 'auto';
}

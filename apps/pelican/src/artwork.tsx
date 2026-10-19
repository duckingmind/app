import React, { useId } from "react";

export type Scene = "coast" | "meadow" | "sunset";
export type Palette = "teal" | "coral" | "mustard" | "lavender";
export type ArtworkSettings = {
  scene: Scene;
  palette: Palette;
  wing: "light" | "dark";
  lineWeight: number;
  decorations: boolean;
  variant: number;
};

export const DEFAULT_SETTINGS: ArtworkSettings = {
  scene: "coast",
  palette: "teal",
  wing: "dark",
  lineWeight: 4,
  decorations: true,
  variant: 0,
};

export const PALETTES: Array<{ id: Palette; name: string; color: string }> = [
  { id: "teal", name: "海玻璃", color: "#278d8a" },
  { id: "coral", name: "珊瑚", color: "#e9795b" },
  { id: "mustard", name: "芥末", color: "#d49a32" },
  { id: "lavender", name: "薰衣草", color: "#8976b9" },
];

export const SCENES: Array<{ id: Scene; name: string; description: string }> = [
  { id: "coast", name: "海岸", description: "潮汐与细风纹" },
  { id: "meadow", name: "草甸", description: "柔软丘陵与小花" },
  { id: "sunset", name: "日落", description: "温暖的晚霞天空" },
];

const paletteValues: Record<Palette, { frame: string; accent: string; shadow: string; blush: string }> = {
  teal: { frame: "#278d8a", accent: "#f4b347", shadow: "#23616a", blush: "#ef9a83" },
  coral: { frame: "#e9795b", accent: "#f2b54f", shadow: "#40566b", blush: "#ef8f75" },
  mustard: { frame: "#c78f2f", accent: "#eeae43", shadow: "#365e67", blush: "#e88a73" },
  lavender: { frame: "#8976b9", accent: "#eea64d", shadow: "#3e506c", blush: "#df91a5" },
};

function uid(raw: string): string {
  return raw.replace(/:/g, "");
}

export function PelicanArtwork({ settings, animated = false, className, id }: { settings: ArtworkSettings; animated?: boolean; className?: string; id?: string }) {
  const reactId = uid(useId());
  const prefix = `pelican-${reactId}`;
  const c = paletteValues[settings.palette];
  const line = Math.max(1.5, Math.min(9, settings.lineWeight || 4));
  const darkWing = settings.wing === "dark";
  const seed = Number.isFinite(settings.variant) ? Math.abs(Math.round(settings.variant)) : 0;
  const variant = seed % 3;
  const sky = settings.scene === "sunset" ? "#f7d4af" : "#f9f1dc";
  const ground = settings.scene === "coast" ? "#d2e2d1" : settings.scene === "meadow" ? "#c3d9b9" : "#e6c69e";
  const horizon = settings.scene === "coast" ? "#a9c9c3" : settings.scene === "meadow" ? "#8eb18c" : "#d99471";
  const sun = settings.scene === "sunset" ? "#f29b65" : "#f5c75d";
  const aria = `${SCENES.find((s) => s.id === settings.scene)?.name ?? "海岸"}鹈鹕骑车插画`;
  const bikeY = variant === 1 ? 386 : variant === 2 ? 394 : 390;
  const skyOffset = variant === 1 ? 31 : variant === 2 ? -24 : 0;
  const cloudX = (seed * 17) % 53;
  const cloudY = (seed * 7) % 19;
  const grassOffset = (seed * 11) % 28;
  return (
    <svg className={className} id={id} viewBox="0 0 800 600" width="100%" height="100%" role="img" aria-label={aria} xmlns="http://www.w3.org/2000/svg" stroke="#29434a">
      <style>{`
        .${prefix}-stroke{stroke-width:${line};stroke-linecap:round;stroke-linejoin:round}
        .${prefix}-thin{stroke:#78989a;stroke-width:${Math.max(1,line * .55)};stroke-linecap:round}
        .${prefix}-wheel{transform-box:fill-box;transform-origin:50% 50%;animation:${prefix}-spin 5s linear infinite}
        .${prefix}-cloud{animation:${prefix}-drift 12s ease-in-out infinite alternate}
        @keyframes ${prefix}-spin{to{transform:rotate(360deg)}}
        @keyframes ${prefix}-drift{to{transform:translateX(14px)}}
        @media (prefers-reduced-motion:reduce){.${prefix}-wheel,.${prefix}-cloud{animation:none}}
        ${animated ? "" : `.${prefix}-wheel,.${prefix}-cloud{animation:none}`}
      `}</style>
      <defs>
        <linearGradient id={`${prefix}-sky`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={sky}/><stop offset="1" stopColor={settings.scene === "sunset" ? "#f4b98d" : "#fff9e9"}/></linearGradient>
        <filter id={`${prefix}-paper`} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB"><feTurbulence baseFrequency=".72" numOctaves="2" seed="4" result="noise"/><feColorMatrix in="noise" type="saturate" values="0"/><feComponentTransfer><feFuncA type="table" tableValues="0 .035"/></feComponentTransfer><feBlend in="SourceGraphic" mode="multiply"/></filter>
      </defs>
      <rect width="800" height="600" fill={`url(#${prefix}-sky)`} stroke="none" filter={`url(#${prefix}-paper)`}/>
      <circle cx={(settings.scene === "sunset" ? 650 : 133) + skyOffset} cy="123" r={settings.scene === "sunset" ? 47 : 34} fill={sun} stroke="none"/>
      <g transform={`translate(${cloudX} ${cloudY})`} fill="#fffdf3" opacity=".9" stroke="none">
        <g className={`${prefix}-cloud`}><path d="M76 210c0-13 12-24 26-24 8-18 34-20 45-2 20-8 42 7 42 27H76Z"/><path d={settings.scene === "sunset" ? "M505 103c0-10 9-18 20-18 9-16 31-15 39 1 16-5 31 6 31 20h-90Z" : "M590 114c0-10 9-18 20-18 9-16 31-15 39 1 16-5 31 6 31 20h-90Z"} opacity=".78"/></g>
      </g>
      {settings.decorations && settings.scene !== "sunset" && <g fill="none" stroke={sun} strokeWidth="2.5" strokeLinecap="round" transform={`translate(${skyOffset} 0)`}><path d="M133 75v-9M133 171v9M85 123h-9M181 123h9M99 89l-6-6M167 157l6 6M167 89l6-6M99 157l-6 6"/></g>}
      {settings.scene === "coast" && <><path d="M0 381c126-26 175-6 264-12 165-10 219 32 360 2 61-13 108-14 176-1v232H0Z" fill="#d9e8df" stroke="none"/><path d="M0 439c109-32 163 14 299-6 126-19 213 4 300 0 76-4 116-12 201 0v167H0Z" fill={ground} stroke="none"/></>}
      {settings.scene === "meadow" && <><path d="M0 399c131-80 230 8 353-16 128-25 199-91 347-22 38 18 69 27 100 24v215H0Z" fill="#dfebd8" stroke="none"/><path d="M0 465c123-21 217-8 339-2 114 5 309-35 461-21v158H0Z" fill={ground} stroke="none"/></>}
      {settings.scene === "sunset" && <><path d="M0 393c106-31 180 1 275-12 118-16 206 31 296 7 84-22 154-14 229 9v208H0Z" fill={ground} stroke="none"/><path d="M0 451c154-12 224 14 343 2 166-17 284 23 457-4v151H0Z" fill="#dfb68b" stroke="none"/></>}
      {settings.scene === "coast" && <path d="M0 434c98-8 183-3 282-7 127-5 201 7 291 4 85-3 146-5 227 1" fill="none" stroke={horizon} strokeWidth="3" opacity=".75"/>}
      <g opacity=".8" className={`${prefix}-thin`} fill="none">
        {settings.scene === "coast" ? <><path d="M83 307h70M103 321h46M625 300h64M646 314h42"/><path d="M78 472c42-12 76-12 118 0M595 464c44-11 79-10 124 1"/></> : <><path d="M56 444c38-12 71-12 104 0M620 446c40-12 72-10 112 2"/></>}
      </g>
      <ellipse cx="413" cy="526" rx="250" ry="12" fill={horizon} opacity=".28" stroke="none"/>
      <g transform={`translate(0 ${bikeY - 390})`}>
        <g className={`${prefix}-wheel`}>
          <circle cx="240" cy="445" r="78" fill="#fcf9ee" strokeWidth={line * 1.8}/><circle cx="240" cy="445" r="67" fill="none" stroke="#d7ba7d" strokeWidth="1.3"/><g className={`${prefix}-thin`}>{Array.from({ length: 16 }, (_, i) => <line key={`a${i}`} x1="240" y1="445" x2={240 + Math.cos(i * Math.PI / 8) * 66} y2={445 + Math.sin(i * Math.PI / 8) * 66}/>)}</g><circle cx="240" cy="445" r="6" fill="#29434a"/>
        </g>
        <g className={`${prefix}-wheel`}>
          <circle cx="576" cy="445" r="78" fill="#fcf9ee" strokeWidth={line * 1.8}/><circle cx="576" cy="445" r="67" fill="none" stroke="#d7ba7d" strokeWidth="1.3"/><g className={`${prefix}-thin`}>{Array.from({ length: 16 }, (_, i) => <line key={`b${i}`} x1="576" y1="445" x2={576 + Math.cos(i * Math.PI / 8) * 66} y2={445 + Math.sin(i * Math.PI / 8) * 66}/>)}</g><circle cx="576" cy="445" r="6" fill="#29434a"/>
        </g>
        <g fill="none" className={`${prefix}-stroke`}>
          <path d="M240 445 342 345 406 445H240M342 345h161L406 445M502 329l74 116" strokeWidth={line * 2.5}/><path d="M240 445 342 345 406 445H240M342 345h161L406 445M502 329l74 116" stroke={c.frame} strokeWidth={line * 1.2}/><path d="M342 345l-12-27M501 329l-9-24 32-7"/><path d="M311 318h37" strokeWidth={line * 2.2}/><path d="M516 299l16-5" stroke={c.accent} strokeWidth={line * 1.5}/>
        </g>
        <path d="M242 452h163" stroke="#29434a" strokeWidth={line * 1.5}/><path d="M242 452h163" stroke="#f9f6e7" strokeWidth={line * .8}/><circle cx="406" cy="445" r="16" fill="#f9f6e7" className={`${prefix}-stroke`}/><path d="M406 445l-24-25M406 445l32 19" className={`${prefix}-stroke`}/><path d="M370 419h22M427 464h23" className={`${prefix}-stroke`}/>
        <g className={`${prefix}-stroke`}>
          <path d="M348 350l19 50 27 25-8 11-31-28-22-54Z" fill="#eeb04a"/>
          <path d="M382 422l17 3 7 12h-29l-2-4Z" fill={c.accent}/>
          <path d="M280 299c29-26 70-18 102 4 34-1 46-32 45-62-11-22-8-47 5-67 11-17 35-24 52-13 17 11 25 32 13 50l-18 10c-20 12-16 29-15 49 4 31-7 59-26 77-30 29-81 33-123 12-25-12-41-31-47-55l-25-19 27 7-15-25Z" fill="#fffdf5"/>
          <path d="M433 175l-4-15 10 8M445 162l-2-14 11 11" fill="#fffdf5"/>
          <path d="M456 230c-3 36-9 67-28 84 16-5 30-23 34-46Z" fill="#dbe9e0" stroke="none"/>
          <path d="M382 352l29 37-9 34 21 18-11 8-29-21 11-35-28-36Z" fill={c.accent}/>
          <path d="M411 438l9-6 20 11 10 9h-33l-10-7Z" fill={c.accent}/>
          <path d="M291 310c18-16 44-11 62 1l35 22c-19 15-45 17-67 6-19-10-27-18-30-29Z" fill={darkWing ? c.shadow : "#e8f0e8"}/>
          <g fill="none" stroke={darkWing ? "#8fb5af" : "#9fbdb4"} strokeWidth={line * .52}><path d="M306 313c13 4 27 14 40 21M317 308c13 4 27 14 40 21M303 326l22 12"/></g>
          <path d="M369 326c21 15 45 18 70 20 30 1 50 2 69-1l4 9c-25 9-53 9-78 5-25-2-47-5-65-16" fill="#fffdf5"/>
          <path d="M502 346l14-3 5 5-9 7" fill="#fffdf5"/>
          <ellipse cx="471" cy="181" rx="7" ry="8" fill="#fffdf5" strokeWidth={line * .6}/><circle cx="473" cy="182" r="3.5" fill="#29434a" stroke="none"/>
          <path d="M461 168c4-2 8-1 11 1" fill="none" strokeWidth={line * .65}/><ellipse cx="461" cy="203" rx="7" ry="5" fill={c.blush} opacity=".84" stroke="none"/>
          <path d="M490 194c54 1 107 7 166 18 7 1 8 5 0 7-57 9-110 4-163-4Z" fill="#f6c860"/>
          <path d="M493 215c3 27 23 49 52 50 43 3 81-25 111-46-54 6-111 2-163-4Z" fill={c.accent}/>
          <path d="M507 230c5 14 15 24 31 25M544 255l10 1" fill="none" stroke="#ffe2a4" strokeWidth={line * 1.2}/>
          <path d="M494 201c48 2 95 8 142 14" fill="none" stroke="#fff1b6" strokeWidth={line * .65}/>
        </g>
      </g>
      {settings.decorations && <g fill="none" className={`${prefix}-stroke`} opacity=".75">
        <path d="M96 527c4-27 8-37 20-49M105 510l-13-10M107 498l13-13" stroke={c.frame} transform={`translate(${grassOffset} 0)`}/>
        <path d="M700 526c0-23 6-36 19-47M710 507l-13-8M713 495l14-10" stroke={c.frame} transform={`translate(${-grassOffset / 2} 0)`}/>
        <path d="M157 281h47M168 295h29M625 255h51M638 269h27" stroke={c.frame} opacity=".55"/>
        <path d="M142 529c5-10 14-13 21-6 5 7 2 16-8 21-9-5-15-9-13-15ZM669 531c4-9 12-12 18-6 5 6 2 13-7 18-8-4-12-7-11-12Z" fill={c.accent} stroke="none" transform={`translate(${grassOffset / 3} 0)`}/>
        <g stroke="none" fill="#fffdf3">{Array.from({ length: 7 }, (_, i) => <circle key={`petal-${i}`} cx={82 + ((i * 109 + seed * 29) % 633)} cy={550 + ((i * 13 + seed * 3) % 22)} r={i % 2 === 0 ? 2.4 : 1.5} opacity=".82"/>)}</g>
      </g>}
    </svg>
  );
}

export default PelicanArtwork;

/**
 * The pictures of the report on the debts: the look of a block, and a block of the page turned into a PNG to send on.
 *
 * A block looks the same whatever theme the app is in, and the same in the picture as on the screen: its look is this
 * one piece of CSS, which the page carries in a <style> and the picture carries inside itself. The picture is always
 * 760 px wide, drawn twice as dense; on a narrow screen the block on the page folds (the rules at the end), and the
 * picture does not.
 */

/** The width of a picture, in CSS pixels. */
export const PICTURE_WIDTH = 760;

/** The look of a block. Nothing here may hold "<" or "&": it is put into the SVG of the picture as it is. */
export const BLOCK_CSS = `
.dr-block{--bg:#151514;--t1:#f0efec;--t2:#c3c2b7;--tm:#898781;--bd:rgba(255,255,255,.10);--bds:rgba(255,255,255,.22);--ok:#3fb950;--bad:#f07a7a;--acc:#3987e5;--accbg:#1c2b40;--wbg:#3a2a08;--w:#e8a33a;--dbg:#4a1a1a;--d:#f07a7a;
box-sizing:border-box;width:100%;margin:0;padding:18px 16px 14px;background:var(--bg);color:var(--t1);font-family:"Segoe UI",system-ui,Arial,sans-serif;font-size:16px;line-height:1.35;text-align:left;font-variant-numeric:tabular-nums;-webkit-text-size-adjust:100%}
.dr-block *{box-sizing:border-box;margin:0;padding:0;border:0;font:inherit;color:inherit}
.dr-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px}
.dr-tiles.dr-three{grid-template-columns:repeat(3,minmax(0,1fr))}
.dr-tile{padding:10px 14px 12px;border:1px solid transparent;border-radius:8px;min-width:0}
.dr-tile.dr-framed{border-color:var(--bds)}
.dr-tile-label{font-size:13px;color:var(--t2)}
.dr-tile-value{margin-top:4px;font-size:22px;font-weight:700;white-space:nowrap}
.dr-tile-sub{margin-top:4px;font-size:12px;color:var(--tm)}
.dr-ok{color:var(--ok)}.dr-bad{color:var(--bad)}.dr-muted{color:var(--tm)}
.dr-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:28px;margin-top:22px}
.dr-cols.dr-two{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.dr-list-title{font-size:14px;font-weight:700;margin-bottom:10px}
.dr-bar-row{display:grid;grid-template-columns:188px minmax(0,1fr) 72px;align-items:center;column-gap:0;min-height:25.5px;font-size:13px}
.dr-two .dr-bar-row{grid-template-columns:176px minmax(0,1fr) 58px}
.dr-bar-name{display:flex;align-items:center;gap:5px;min-width:0;padding-right:8px}
.dr-code{flex:none;white-space:nowrap}
.dr-bar-name b{font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dr-bar{height:12px;border-radius:0 3px 3px 0;min-width:2px}
.dr-bar.dr-paid{background:#1baf7a}.dr-bar.dr-charged{background:#e34948}.dr-bar.dr-debt{background:#3987e5}
.dr-bar-sum{text-align:right;white-space:nowrap}
.dr-rest{margin-top:8px;padding-top:8px;border-top:1px solid var(--bd);font-size:12px;color:var(--tm)}
.dr-tag{flex:none;display:inline-block;padding:1px 6px;border-radius:4px;background:var(--accbg);color:var(--acc);font-size:11px;line-height:1.35;white-space:nowrap}
.dr-note{margin-top:12px;padding-top:10px;border-top:1px solid var(--bd);font-size:12px;line-height:1.5;color:var(--tm)}
.dr-table{width:100%;border-collapse:collapse;font-size:13px}
.dr-table th{padding:0 8px 8px;font-size:12px;font-weight:400;color:var(--tm);text-align:left;vertical-align:bottom;border-bottom:1px solid var(--bds)}
.dr-table td{padding:6.5px 8px;border-bottom:1px solid var(--bd);vertical-align:middle;white-space:nowrap}
.dr-table tbody tr:last-child td{border-bottom:0}
.dr-table .dr-num{text-align:right}
.dr-top td{border-bottom-color:transparent;padding:4.5px 8px}
.dr-top th.dr-place,.dr-top td.dr-place{width:30px;padding-left:2px;padding-right:0;color:var(--tm)}
.dr-top td.dr-barcell{width:42%;padding-left:0}
.dr-client{display:flex;align-items:center;gap:5px;min-width:0}
.dr-client b{font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dr-plate{display:inline-block;min-width:44px;padding:1px 6px;border-radius:4px;background:var(--wbg);color:var(--w);font-size:12px;text-align:center}
.dr-plate.dr-long{background:var(--dbg);color:var(--d)}
.dr-control th,.dr-control td{padding-left:12px;padding-right:12px}
.dr-control th{font-size:13px;font-weight:700;color:var(--t2);padding-bottom:10px}
.dr-control td{padding-top:9px;padding-bottom:9px;font-size:14px}
.dr-empty{padding:10px 0;font-size:13px;color:var(--tm)}
`;

/** How a block folds on a narrow screen. The page only: a picture is never narrow. */
export const NARROW_CSS = `
.dr-wrap{container-type:inline-size;container-name:dr;width:100%;max-width:${PICTURE_WIDTH}px}
.dr-scroll{overflow-x:auto}
@container dr (max-width: 700px){
.dr-block{padding:14px 10px 12px}
.dr-tiles,.dr-tiles.dr-three{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.dr-tile{padding:8px 10px 10px}
.dr-tile-value{font-size:19px}
.dr-cols.dr-two{grid-template-columns:minmax(0,1fr)}
.dr-bar-row,.dr-two .dr-bar-row{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) 62px}
.dr-table{font-size:12px}
.dr-table th{font-size:11px;padding:0 4px 6px}
.dr-table td{padding:6px 4px}
.dr-top td{padding:4px 4px}
.dr-top th.dr-barcell,.dr-top td.dr-barcell{display:none}
.dr-client b{max-width:30vw}
.dr-control th,.dr-control td{padding-left:4px;padding-right:4px;font-size:12px}
}
`;

/** How many pixels of the picture one CSS pixel is. */
const DENSITY = 2;

/** The block as a PNG, 760 px wide whatever the screen is, as it would look on a wide one. */
export async function pictureOf(block: HTMLElement): Promise<Blob> {
  // Laid out off the screen at the width of a picture, to learn how tall it is there.
  const holder = document.createElement("div");
  holder.style.cssText = `position:fixed;left:-20000px;top:0;width:${PICTURE_WIDTH}px;pointer-events:none`;
  holder.setAttribute("aria-hidden", "true");
  const copy = block.cloneNode(true) as HTMLElement;
  holder.appendChild(copy);
  document.body.appendChild(holder);
  let height: number;
  try {
    height = Math.ceil(copy.getBoundingClientRect().height);
  } finally {
    holder.remove();
  }

  // The same block inside an SVG, with its look: a picture any browser draws by itself.
  const markup = new XMLSerializer().serializeToString(copy);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PICTURE_WIDTH * DENSITY}" height="${height * DENSITY}" viewBox="0 0 ${PICTURE_WIDTH} ${height}">` +
    `<foreignObject x="0" y="0" width="${PICTURE_WIDTH}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${PICTURE_WIDTH}px"><style>${BLOCK_CSS}</style>${markup}</div></foreignObject></svg>`;
  const image = new Image();
  image.decoding = "sync";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The picture of the report could not be drawn"));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await loaded;

  const canvas = document.createElement("canvas");
  canvas.width = PICTURE_WIDTH * DENSITY;
  canvas.height = height * DENSITY;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser draws no pictures");
  context.fillStyle = "#151514";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture of the report could not be made"))), "image/png"));
}

/** Gives a file to the person: saved by the browser under this name. */
export function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Not at once: the browser is still reading it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Hands pictures over: on a phone to the sheet of the system (from where they go straight to a chat), where the
 * browser has one that takes files; anywhere else they are saved as files. False when the person closed the sheet.
 */
export async function givePictures(pictures: ReadonlyArray<{ blob: Blob; name: string }>): Promise<boolean> {
  const files = pictures.map((picture) => new File([picture.blob], picture.name, { type: "image/png" }));
  const phone = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  if (phone && typeof navigator.share === "function" && navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files });
      return true;
    } catch (error) {
      if ((error as Error).name === "AbortError") return false;
      // The sheet did not take them: saved as files instead.
    }
  }
  for (const picture of pictures) saveFile(picture.blob, picture.name);
  return true;
}

/** Whether a picture can be put where «Вставить» takes it from. */
export const canCopyPictures = () => typeof ClipboardItem === "function" && typeof navigator.clipboard?.write === "function";

export async function copyPicture(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

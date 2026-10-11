/**
 * 处理粘贴 / 拖进来的图片。
 *
 * 为什么要在这里缩一遍：一张全屏截图往往 5~10MB，base64 之后更大。
 * 直接塞进请求体和历史里，既慢又贵。这里统一压到**长边不超过 1568px** 并转 JPEG，
 * 绝大多数视觉模型的最佳输入尺寸就在这附近，读界面截图足够清晰。
 *
 * 浏览器里用 canvas 做；拿不到 canvas（或解不出来）就退回原图，不阻断用户。
 */

/** 长边上限。视觉模型通常在 1568px 左右性价比最高。 */
export const MAX_IMAGE_EDGE = 1568;
/** 单张图片压缩后的目标上限（字节）；超过就再降一档质量。 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
/** 一条消息最多带几张。 */
export const MAX_IMAGES = 4;

export interface PreparedImage {
  /** data:image/...;base64,... —— 可以直接放进 image_url.url */
  dataUrl: string;
  width: number;
  height: number;
  /** 压缩后的近似字节数。 */
  bytes: number;
  /** 有说明时给用户看的一句话（例如"已压缩"）。 */
  note?: string;
}

function bytesOfDataUrl(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return dataUrl.length;
  return Math.floor((dataUrl.length - comma - 1) * 0.75);
}

/** 从 File 读成 data URL。没有 FileReader 时返回 null。 */
function readAsDataUrl(file: Blob): Promise<string | null> {
  if (typeof FileReader === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** 用 canvas 缩到长边 <= MAX_IMAGE_EDGE 并转 JPEG。失败返回 null。 */
async function downscale(file: Blob): Promise<PreparedImage | null> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const long = Math.max(bitmap.width, bitmap.height);
    const scale = long > MAX_IMAGE_EDGE ? MAX_IMAGE_EDGE / long : 1;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    if (typeof bitmap.close === 'function') bitmap.close();

    // 先按 0.86 出图，还是太大就降到 0.7（截图里文字多，别一上来就压太狠）。
    let dataUrl = canvas.toDataURL('image/jpeg', 0.86);
    if (bytesOfDataUrl(dataUrl) > MAX_IMAGE_BYTES) {
      dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    }
    return {
      dataUrl,
      width,
      height,
      bytes: bytesOfDataUrl(dataUrl),
      note: scale < 1 ? '已缩到 ' + width + '×' + height : undefined,
    };
  } catch {
    return null;
  }
}

/** 把一张粘贴 / 拖进来的图片处理成可以直接发给模型的形式。 */
export async function prepareImage(file: Blob): Promise<PreparedImage | null> {
  const scaled = await downscale(file);
  if (scaled) return scaled;
  // 缩不了就退回原图 —— 至少别让用户粘贴失败。
  const raw = await readAsDataUrl(file);
  if (!raw) return null;
  return { dataUrl: raw, width: 0, height: 0, bytes: bytesOfDataUrl(raw) };
}

/** 从粘贴事件里挑出图片。 */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    if (!item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  // 有些环境 items 是空的，但 files 里有 —— 兜一层。
  if (out.length === 0) {
    for (const f of Array.from(data.files ?? [])) {
      if (f.type.startsWith('image/')) out.push(f);
    }
  }
  return out;
}

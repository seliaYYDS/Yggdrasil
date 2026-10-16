/** 截图的返回。失败也要给出人能看懂的原因（并让 Agent 把原因转述给用户）。 */
export type ShotResult = { ok: true; dataUrl: string } | { ok: false; error: string };

/**
 * 截图消息的标记（写进消息正文的开头）。
 *
 * 用它把"截图"与"用户自己粘贴的图"区分开：只有带这个标记的消息才会在
 * 下一次截图前被丢掉（见 store 的 dropScreenshotMessages）。
 * 判据必须与写入处一致，所以两处都用这个常量，不各写一遍字符串。
 */
export const SCREENSHOT_TAG = '[截图]';

/** 这条消息是不是一张截图（带标记 + 真的带图）。 */
export function isScreenshotMessage(m: { content?: unknown; images?: unknown }): boolean {
  const hasTag = typeof m.content === 'string' && m.content.startsWith(SCREENSHOT_TAG);
  const hasImage = Array.isArray(m.images) && m.images.length > 0;
  return hasTag && hasImage;
}

/**
 * 传给 `getDisplayMedia` 的**选择器提示**。
 *
 * 浏览器**不允许**网页记住上次的选择，所以每次都一定会弹那个"选择要共享的内容"。
 * 我们能做的只有"把最可能想选的那个摆在最显眼处"，这里用的就是这几个非标准/实验性提示：
 *
 * - `preferCurrentTab`：把**当前标签页**作为最突出的捕获源（选择器里会多一个"此标签页"）。
 *   对这个应用来说这几乎总是想要的：抓的就是自己这一页的真实像素。
 * - `selfBrowserSurface: 'include'`：允许选当前标签页。**必须显式 include** ——
 *   有些浏览器（Chrome 的默认可不是 include）为了防"无限镜厅"会把它排除掉，
 *   那样 `preferCurrentTab` 就没有意义了。
 * - `monitorTypeSurfaces: 'exclude'`：**不提供"整个屏幕"**。理由是隐私与观感：
 *   截桌面会把其它应用、通知、私人窗口一起拍进去，而这个应用要的只是自己的界面。
 * - `surfaceSwitching: 'exclude'`：不显示"切换共享内容"控件（我们一次只要一帧，不需要它）。
 *
 * 这些参数**全是提示**：浏览器不认识就忽略，用户仍然可以选别的东西 ——
 * 所以它们是纯改善，不会让截图失败。类型上它们还没进 TS 的标准库
 * （`selfBrowserSurface` 等连 lib.dom.d.ts 都没有），所以这里显式声明形状再传。
 */
interface DisplayCaptureHints {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: 'include' | 'exclude';
  monitorTypeSurfaces?: 'include' | 'exclude';
  surfaceSwitching?: 'include' | 'exclude';
}

export const CAPTURE_HINTS: DisplayCaptureHints = {
  preferCurrentTab: true,
  selfBrowserSurface: 'include',
  monitorTypeSurfaces: 'exclude',
  surfaceSwitching: 'exclude',
};

/**
 * 抓一张**当前页面的真实截图**。
 *
 * 为什么必须由用户点一下：
 * 浏览器只在**用户手势**里允许 `getDisplayMedia` —— 这是浏览器的硬规定，
 * 不是这里偷懒。Agent 是异步跑的，它的调用本身不构成手势，所以只能：
 * Agent 提出请求 → 弹出一个确认框 → 用户点一下 → 这时才有手势 → 抓图成功。
 *
 * 抓的是"用户选中的那个画面"（选当前标签页就是本应用的真实像素：
 * 连 WebGL 背景、canvas、跨域图片都在内 —— 这是它比"把 DOM 重画一遍"强的地方）。
 */
export async function captureScreen(): Promise<ShotResult> {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  if (!media || typeof media.getDisplayMedia !== 'function') {
    return { ok: false, error: '这个浏览器不支持屏幕捕获（需要 getDisplayMedia）。' };
  }
  let stream: MediaStream | null = null;
  try {
    /*
     * `video: true` 是标准形状；那几个提示参数不在 TS 的 DisplayMediaStreamOptions 里，
     * 所以合并后**显式断言**成参数类型 —— 否则 strict 模式会报"多余属性"。
     */
    stream = await media.getDisplayMedia({
      video: true,
      audio: false,
      ...CAPTURE_HINTS,
    } as DisplayMediaStreamOptions);
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // 有些浏览器首帧还没上屏，等一下再画，否则会拍到一张全黑。
    await new Promise((r) => window.setTimeout(r, 120));
    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 800;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, error: '拿不到 2D 画布，无法保存截图。' };
    ctx.drawImage(video, 0, 0, w, h);
    // JPEG 而不是 PNG：截图是给模型看的，体积小一大截，画质够用。
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    track?.stop();
    if (!dataUrl.startsWith('data:image/')) return { ok: false, error: '截图为空。' };
    return { ok: true, dataUrl };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    // 用户点了"取消"是最常见的情况，给一句人话。
    if (/denied|cancel|NotAllowed/i.test(msg)) return { ok: false, error: '用户取消了截图。' };
    return { ok: false, error: '截图失败：' + msg };
  } finally {
    // 一定要收掉，否则浏览器会一直显示"正在共享屏幕"。
    for (const t of stream?.getTracks() ?? []) t.stop();
  }
}

/**
 * 供测试与调用方判断"现在能不能截图"。不触发任何权限弹窗。
 */
export function canCaptureScreen(): boolean {
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return !!media && typeof media.getDisplayMedia === 'function';
}

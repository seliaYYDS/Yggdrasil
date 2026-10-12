/** 截图的返回。失败也要给出人能看懂的原因（并让 Agent 把原因转述给用户）。 */
export type ShotResult = { ok: true; dataUrl: string } | { ok: false; error: string };

/**
 * 抓一张**当前页面的真实截图**。
 *
 * 为什么必须由用户点一下：
 * 浏览器只在**用户手势**里允许 `getDisplayMedia` —— 这是浏览器的硬规定，
 * 不是这里偷懒。Agent 是异步跑的，它的调用本身不构成手势，所以只能：
 * Agent 提出请求 → 输入框上出现一个按钮 → 用户点一下 → 这时才有手势 → 抓图成功。
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
    stream = await media.getDisplayMedia({ video: true, audio: false });
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

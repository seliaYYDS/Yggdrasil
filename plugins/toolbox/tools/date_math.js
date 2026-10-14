/**
 * 日期运算。**模型最不擅长的一类计算**：内置的 now 只给"此刻"，
 * 而"30 天后是哪天""这两个日期差几天"它经常算错（月份长度、闰年、跨年都容易翻车）。
 *
 * 单位写法有意避开 m/M 的经典歧义（m 到底是分钟还是月？）：
 *   y 年 / mo 月 / w 周 / d 天 / h 小时 / mi 分钟 / s 秒
 * 也接受英文单词（3 days、2 weeks）。月与年走**日历运算**，不是固定毫秒数。
 */
async (args, ctx) => {
  const UNIT = {
    y: 'year', yr: 'year', year: 'year', years: 'year',
    mo: 'month', month: 'month', months: 'month',
    w: 'week', wk: 'week', week: 'week', weeks: 'week',
    d: 'day', day: 'day', days: 'day',
    h: 'hour', hr: 'hour', hour: 'hour', hours: 'hour',
    mi: 'minute', min: 'minute', minute: 'minute', minutes: 'minute',
    s: 'second', sec: 'second', second: 'second', seconds: 'second',
  };
  // 长的写法排在前面，否则 "months" 会被 "mo" 先吃掉、剩下 "nths"。
  const UNIT_RE = new RegExp('(-?\\d+(?:\\.\\d+)?)\\s*(years|year|yr|y|months|month|mo|weeks|week|wk|w|days|day|d|hours|hour|hr|h|minutes|minute|min|mi|seconds|second|sec|s)', 'gi');
  const ZONE_RE = /^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)*$/;

  const parseInstant = (text, what) => {
    const t = String(text || '').trim();
    if (!t || t.toLowerCase() === 'now') return new Date();
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) throw new Error(what + ' 不是一个能认出来的时间：' + t + '（用 ISO 格式，如 2024-03-01T00:00:00Z，或写 now）');
    return d;
  };

  const start = parseInstant(args.base, 'base');
  const tz = String(args.tz || 'UTC').trim();

  /** 给定时区（或 UTC）下的时间字段。用 formatToParts 自己拼，避免被 locale 的怪格式影响。 */
  const inZone = (d) => {
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
      });
    } catch (e) { throw new Error('时区认不出来：' + tz + '（用 IANA 名字，如 Asia/Shanghai、UTC）'); }
    const parts = {};
    for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
    const pad = (x) => (x === '24' ? '00' : x);
    return {
      timeZone: tz,
      local: parts.year + '-' + parts.month + '-' + parts.day + ' ' + pad(parts.hour) + ':' + parts.minute + ':' + parts.second,
      weekday: parts.weekday,
    };
  };

  const msToHuman = (ms) => {
    const abs = Math.abs(ms);
    const sign = ms < 0 ? '-' : '';
    const d = Math.floor(abs / 86400000);
    const h = Math.floor((abs % 86400000) / 3600000);
    const mi = Math.floor((abs % 3600000) / 60000);
    const parts = [];
    if (d) parts.push(d + ' 天');
    if (h) parts.push(h + ' 小时');
    if (mi || parts.length === 0) parts.push(mi + ' 分钟');
    return sign + parts.join(' ');
  };

  // 给了 until → 算两点的间隔（"还有几天"这种问题）
  if (args.until !== undefined && args.until !== '' && args.until !== null) {
    const until = parseInstant(args.until, 'until');
    const ms = until.getTime() - start.getTime();
    ctx.log('间隔 ' + msToHuman(ms));
    return {
      from: start.toISOString(),
      until: until.toISOString(),
      milliseconds: ms,
      days: Math.round((ms / 86400000) * 1000) / 1000,
      hours: Math.round((ms / 3600000) * 1000) / 1000,
      weeks: Math.round((ms / 604800000) * 1000) / 1000,
      human: msToHuman(ms),
      calendarDaysBetween: Math.round((Date.UTC(until.getFullYear(), until.getMonth(), until.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / 86400000),
    };
  }

  const addText = String(args.add || '').trim();
  if (!addText) throw new Error('给我 add（要加多少，如 "3d"、"-2w"、"1mo"）或 until（另一个时间点）。');
  const delta = { year: 0, month: 0, week: 0, day: 0, hour: 0, minute: 0, second: 0 };
  let matched = 0;
  let m;
  UNIT_RE.lastIndex = 0;
  while ((m = UNIT_RE.exec(addText)) !== null) {
    const unit = UNIT[String(m[2]).toLowerCase()];
    if (!unit) throw new Error('认不出的单位：' + m[2]);
    delta[unit] += Number(m[1]);
    matched += 1;
  }
  if (matched === 0) throw new Error('解析不了 add：' + addText + '（写成 "3d" / "2 weeks" / "-1mo" 这样）');
  if (!ZONE_RE.test(tz)) throw new Error('时区认不出来：' + tz);

  /*
   * 日历运算**按 UTC 做**，只有"显示"才用 tz。
   *
   * 为什么：setMonth/setDate 走的是运行环境的**本地时区**，于是同一个输入在
   * 不同机器上会算出不同的结果 —— 一个给 Agent 用的工具不该有这种不确定性。
   * tz 参数的作用因此是明确的："给定时区下的本地时间长什么样"，而不是"在给定时区里做运算"。
   */
  const out = new Date(start.getTime());

  /**
   * 加月份并**夹到月末**。
   *
   * 不夹的话 JS 会溢出：2024-01-31 + 1mo 得到 **3 月 2 日** ——
   * 那不是"一个月后"，而是"2 月 31 日"被 JS 顺延的结果。
   * 人对"加一个月"的预期是 2 月 29 日（月末对齐），这也是各日期库的通行做法。
   * 这个坑只能靠夹取解决，测出来的第一条真实缺陷就是它。
   */
  const addMonths = (d, months) => {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + months);
    // 目标月的最后一天：下个月的第 0 天。
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
  };

  // 先做日历年月（夹取依赖"基准日的日号"），再加其余单位。
  // 周/日/时/分/秒在 UTC 下用毫秒加是**完全等价**的（没有夏令时），顺带还支持小数。
  addMonths(out, delta.year * 12 + delta.month);
  const ms = ((delta.week * 7 + delta.day) * 86400 + delta.hour * 3600 + delta.minute * 60 + delta.second) * 1000;
  out.setTime(out.getTime() + ms);

  const zone = inZone(out);
  ctx.log(start.toISOString() + ' + ' + addText + ' = ' + out.toISOString());
  return {
    base: start.toISOString(),
    add: addText,
    iso: out.toISOString(),
    ...zone,
    unixSeconds: Math.floor(out.getTime() / 1000),
    weekdayZh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][out.getUTCDay()],
    applied: delta,
  };
}

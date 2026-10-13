import { embedValue, getEntry, markersIn, validName } from './store';

/**
 * 把组件源码里的 **@ws/名字** 标记换成真实内容（**复制**，不是链接）。
 *
 * 这是整个工作区设计的落点：Agent 写 "@ws/logo.png"，宿主在这里把字节变成
 * data URL 写进源码。替换之后组件与工作区再无关系 —— 之后删文件、清空工作区，
 * 已经做好的界面都毫发无损。这是"工作区可以随时清掉"这个承诺的技术基础。
 *
 * 这里**只负责替换**；"内容太大就别回灌给模型"由 hide.ts 的隐藏协议负责
 * （它在回读那一层统一处理，因为嵌入只是长内容的一个来源，不是唯一来源）。
 */
export interface EmbedOutcome {
  /** 替换后的源码（真正写进节点的就是这一份）。 */
  source: string;
  /** 用到了哪些工作区文件。 */
  used: string[];
  /** 出错的标记（引用了不存在的文件等）。 */
  errors: string[];
}

/** 一次嵌入里最多替换几次（防止源码里塞满标记把工作区整个搬进组件）。 */
const MAX_EMBEDS = 12;

export async function embedMarkers(source: string): Promise<EmbedOutcome> {
  const names = markersIn(source);
  if (names.length === 0) return { source, used: [], errors: [] };

  if (names.length > MAX_EMBEDS) {
    return {
      source,
      used: [],
      errors: ['一次最多嵌入 ' + MAX_EMBEDS + ' 个工作区文件（源码里出现了 ' + names.length + ' 个 @ws/ 标记）。'],
    };
  }

  let next = source;
  const used: string[] = [];
  const errors: string[] = [];

  for (const name of names) {
    if (!validName(name)) {
      errors.push('"' + name + '" 不是合法的工作区名字。');
      continue;
    }
    const entry = await getEntry(name);
    if (!entry) {
      // 明确报错而不是留一个裸标记在源码里 —— 后者会变成一张打不开的图，且很难查。
      errors.push('工作区里没有 ' + name + '（用 ws_list 看有什么）。');
      continue;
    }
    const value = await embedValue(entry);
    /*
     * 标记可能以三种写法出现，按"最具体优先"替换一次：
     *   src="@ws/a.png"   双引号里 → 整体换成 JSON 字符串字面量
     *   src='@ws/a.png'   单引号里 → 转义单引号后放进去
     *   @ws/a.png         裸标记   → 包成 JSON 字符串（放进 JSON 里也站得住）
     */
    const jsonLiteral = JSON.stringify(value);
    const dq = '"@ws/' + name + '"';
    const sq = "'@ws/" + name + "'";
    const bare = '@ws/' + name;
    if (next.includes(dq)) {
      next = next.split(dq).join(jsonLiteral);
    } else if (next.includes(sq)) {
      next = next.split(sq).join(jsonLiteral.slice(1, -1).split("'").join("\\'"));
    } else if (next.includes(bare)) {
      next = next.split(bare).join(jsonLiteral);
    } else {
      continue;
    }
    used.push(name);
  }

  return { source: next, used, errors };
}

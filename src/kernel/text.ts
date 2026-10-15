/**
 * 界面文案的纯文本化。
 *
 * 存在的理由很直接：**界面上没有任何 markdown 渲染能力**。所以文案里写 `**这个**`
 * （插件清单由第三方提供，应用自己的文案也难免），用户看到的是那对星号本身 ——
 * 标记成了正文，而它本来想强调的词反而不突出。
 *
 * 只去掉成对包裹的粗体标记（`**…**` 与 `__…__`，两端都不能是空白），
 * 不动单个星号与下划线：它们极可能是正文（`*.tsx`、`ws_read`、`snake_case`），
 * 一律替换会把正常文字改坏 —— 那是比多显示两个星号更糟的错。
 */
export function plainText(text: string): string {
  return text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(/__(?=\S)([\s\S]*?\S)__/g, '$1');
}

/** 对一串文案逐条纯文本化。 */
export function plainLines(lines: string[]): string[] {
  return lines.map(plainText);
}

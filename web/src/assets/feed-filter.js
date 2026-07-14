// 首页信息流的可见性 + 计数纯函数。DOM 层（feed.js）只做映射与套用，逻辑全在此处便于单测。
// items：有序数组，元素 { kind:'card'|'sep', type? }。
// filters：{ type:'all'|<类型> }。
// 返回 { visible:boolean[], count:number }，visible 与 items 一一对应；count 为可见卡片数。
export function computeFeedView(items, { type = "all" } = {}) {
  const visible = new Array(items.length).fill(false);
  let count = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "card") continue;
    visible[i] = type === "all" || it.type === type;
    if (visible[i]) count++;
  }

  // 月分隔：本段（到下一个 sep 之前）有任一可见卡片才显示。
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind !== "sep") continue;
    let any = false;
    for (let j = i + 1; j < items.length && items[j].kind !== "sep"; j++) {
      if (visible[j]) { any = true; break; }
    }
    visible[i] = any;
  }

  return { visible, count };
}

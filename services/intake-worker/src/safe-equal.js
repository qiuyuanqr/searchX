// services/intake-worker/src/safe-equal.js
// 恒定时间字符串比较：等长时不在首个不同字符处提前返回，逐字符 XOR 累加后才给结论，
// 耗时与内容无关 → 杜绝靠"对前几位会更慢"逐位猜密钥的时序侧信道。等长前提下连长度也不泄露。
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false; // 定长随机密钥，长度本身无信息量
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

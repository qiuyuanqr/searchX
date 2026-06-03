// 把 {{KEY}} 占位从扁平配置对象注入模板字符串；未知键原样保留。
export function injectConfig(template, config) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) =>
    key in config ? String(config[key]) : m
  );
}

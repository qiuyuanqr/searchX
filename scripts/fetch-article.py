#!/usr/bin/env python3
"""scripts/fetch-article.py — 本机直抓网页正文（/factcheck 链接输入的兜底通路）。

用法：
    python3 scripts/fetch-article.py <url>                 抓取并把正文以 markdown 打到 stdout
    python3 scripts/fetch-article.py <url> --html <file>   不联网，解析本地 HTML（测试 / 排障用）

为什么要有这个脚本：微信公众号等站点对数据中心 IP 与无头抓取器返回「环境异常 / 去验证」的验证页，
WebFetch 与 jina 阅读代理都拿不到正文；而从本机（住宅网络）用手机 UA 直连，公众号文章能正常
返回全文（2026-09-17 用一条此前判为「抓取失败」的公众号链接实测成功）。本脚本只依赖 macOS
自带的 python3 与 curl，MacBook / Mac mini 两端都不用装东西。

退出码：0 成功；2 对方仍返回验证页（换截图 / 贴正文）；3 HTTP 或网络错误；4 参数错误或 URL 被拒（非 http(s) / 内网地址）。
输出为纯文本 markdown：抬头几行元信息（标题 / 作者或公众号 / 发布时间 / URL），空行后是正文。
正文超过 MAX_CHARS 截断并注明——核查读前几万字足够，别把整站倒进上下文。
"""
import html
import ipaddress
import re
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit

UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
MAX_CHARS = 30000
CST = timezone(timedelta(hours=8))

# 常见验证页 / 反爬拦截页特征：命中即判「抓到的不是正文」（退出码 2），绝不把验证页当文章交出去。
BLOCK_MARKERS = ("环境异常", "去验证", "完成验证后即可继续访问", "请完成安全验证", "captcha", "Access Denied")


def url_rejected(url):
    """URL 来自用户提交内容（不可信）：只放行 http(s)，拒绝本机 / 内网 / 链路本地地址，
    防止被当成内网探测或本地文件读取的跳板（curl 默认连 file:// 都接）。返回拒绝原因或 None。"""
    try:
        u = urlsplit(url)
    except ValueError:
        return "URL 无法解析"
    if u.scheme not in ("http", "https"):
        return f"只支持 http/https（收到 {u.scheme or '无协议'}）"
    host = (u.hostname or "").strip("[]").lower()
    if not host:
        return "URL 没有主机名"
    if host in ("localhost",) or host.endswith(".local") or host.endswith(".internal"):
        return f"拒绝本机 / 内网主机名：{host}"
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return None  # 普通域名：放行（域名解析到内网的情况由 --proto 与超时兜底，不在此脚本职责内）
    if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
        return f"拒绝内网 / 本机 IP：{host}"
    return None


def fetch(url):
    """curl 直抓：只走 http(s)（含跳转）、跟随跳转、手机 UA、25 秒超时；返回 (http_code, body_bytes, err)。"""
    cmd = ["curl", "-sS", "-L", "-m", "25", "--compressed", "--proto", "=http,https", "--proto-redir", "=http,https",
           "-A", UA, "-w", "\n%{http_code}", url]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=40).stdout
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        return 0, b"", str(e)
    body, _, code = out.rpartition(b"\n")
    try:
        return int(code.decode().strip() or 0), body, ""
    except ValueError:
        return 0, out, "无法解析 HTTP 状态码"


def decode(body):
    """按页面声明的编码解码；公众号是 UTF-8，老门户常见 GBK。"""
    head = body[:4096].decode("ascii", "ignore").lower()
    m = re.search(r'charset=["\']?([a-z0-9_-]+)', head)
    enc = (m.group(1) if m else "utf-8").replace("gb2312", "gbk")
    for e in (enc, "utf-8", "gbk"):
        try:
            return body.decode(e)
        except (UnicodeDecodeError, LookupError):
            continue
    return body.decode("utf-8", "ignore")


def strip_tags(fragment):
    """HTML 片段 → 保留段落换行的纯文本。"""
    s = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", "", fragment)
    s = re.sub(r"(?i)<br\s*/?>", "\n", s)
    s = re.sub(r"(?i)</(p|div|section|li|h[1-6]|tr|blockquote)>", "\n", s)
    # 图片只留一个占位（公众号正文常见「图 + 一句说明」，占位能让核查知道这里有配图）
    s = re.sub(r"(?i)<img[^>]*>", "〔图〕", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t　\xa0]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n\n", s)
    return s.strip()


def meta(page, name):
    m = re.search(r'<meta[^>]+(?:property|name)=["\']%s["\'][^>]+content=["\']([^"\']*)["\']' % re.escape(name), page, re.I)
    if not m:
        m = re.search(r'<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']%s["\']' % re.escape(name), page, re.I)
    return html.unescape(m.group(1)).strip() if m else ""


def parse_weixin(page):
    """公众号页：标题 #activity-name、公众号名 #js_name、发布时间 var ct、正文 #js_content。"""
    title = ""
    m = re.search(r'<h1[^>]*id="activity-name"[^>]*>(.*?)</h1>', page, re.S)
    if m:
        title = strip_tags(m.group(1))
    title = title or meta(page, "og:title")
    account = ""
    m = re.search(r'id="js_name"[^>]*>(.*?)</', page, re.S)
    if m:
        account = strip_tags(m.group(1))
    account = account or meta(page, "author")
    published = ""
    m = re.search(r'var\s+ct\s*=\s*"?(\d{10})"?', page)
    if m:
        published = datetime.fromtimestamp(int(m.group(1)), CST).strftime("%Y-%m-%d %H:%M 北京时间")
    body = ""
    m = re.search(r'id="js_content"[^>]*>(.*)', page, re.S)
    if m:
        frag = m.group(1)
        cut = re.search(r'<div[^>]+id="js_pc_qr_code"|<div[^>]+class="[^"]*rich_media_tool', frag)
        if cut:
            frag = frag[:cut.start()]
        body = strip_tags(frag)
    return title, account, published, body


def parse_generic(page):
    title = meta(page, "og:title")
    if not title:
        m = re.search(r"<title[^>]*>(.*?)</title>", page, re.S | re.I)
        title = strip_tags(m.group(1)) if m else ""
    site = meta(page, "og:site_name") or meta(page, "author")
    published = meta(page, "article:published_time") or meta(page, "pubdate") or meta(page, "publishdate")
    body = ""
    for pat in (r"<article[^>]*>(.*?)</article>", r"<main[^>]*>(.*?)</main>", r"<body[^>]*>(.*?)</body>"):
        m = re.search(pat, page, re.S | re.I)
        if m:
            body = strip_tags(m.group(1))
            if len(body) > 200:
                break
    desc = meta(page, "description") or meta(page, "og:description")
    return title, site, published, body, desc


def main(argv):
    if len(argv) < 2 or argv[1].startswith("-"):
        print("用法：python3 scripts/fetch-article.py <url> [--html <file>]", file=sys.stderr)
        return 4
    url = argv[1]
    reason = url_rejected(url)
    if reason:
        print(f"拒绝抓取：{reason}", file=sys.stderr)
        return 4
    html_file = None
    if "--html" in argv:
        i = argv.index("--html")
        if i + 1 >= len(argv):
            print("--html 后要跟文件路径", file=sys.stderr)
            return 4
        html_file = argv[i + 1]

    if html_file:
        with open(html_file, "rb") as f:
            body_bytes = f.read()
        code = 200
    else:
        code, body_bytes, err = fetch(url)
        if err or code == 0:
            print(f"抓取失败：{err or '无响应'}（{url}）", file=sys.stderr)
            return 3
        if code >= 400:
            print(f"HTTP {code}（{url}）", file=sys.stderr)
            return 3

    page = decode(body_bytes)
    is_weixin = "mp.weixin.qq.com" in url
    if is_weixin:
        title, source, published, body = parse_weixin(page)
        desc = ""
    else:
        title, source, published, body, desc = parse_generic(page)

    # 正文为空且页面带验证页特征 → 明确告诉调用方「拿到的是验证页」，别当成"文章没内容"
    if len(body) < 80 and any(k in page for k in BLOCK_MARKERS):
        print(f"对方返回验证页（环境异常 / 去验证），本机直抓也拿不到正文：{url}", file=sys.stderr)
        return 2

    truncated = len(body) > MAX_CHARS
    if truncated:
        body = body[:MAX_CHARS]

    lines = [
        f"标题: {title or '（未取到）'}",
        f"来源: {source or ('微信公众号' if is_weixin else '（未取到）')}",
        f"发布时间: {published or '（页面未标注）'}",
        f"URL: {url}",
        f"抓取时间: {datetime.now(CST).strftime('%Y-%m-%d %H:%M 北京时间')}（本机直抓，手机 UA）",
        f"正文字数: {len(body)}" + ("（已截断到前 %d 字）" % MAX_CHARS if truncated else ""),
    ]
    if desc:
        lines.append(f"摘要: {desc}")
    print("\n".join(lines))
    print()
    print(body if body else "（正文为空：页面可能靠脚本渲染，或站点结构不在解析范围内）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

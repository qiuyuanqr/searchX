"""Deterministic host assembly of untrusted stock fragments and cover metadata.

Only static report markup is accepted. This validates structure and encoding,
not facts, privacy, source credibility, or investment conclusions.
"""
from datetime import date as calendar_date
import html
from html.parser import HTMLParser
import json
import re
from urllib.parse import quote, urlsplit


BOARDS = ['光模块', '机器人', '算力', 'AI应用', '航天']
_TEXT = {'type': 'string', 'minLength': 1, 'maxLength': 20000}
COVER_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {
        **{name: dict(_TEXT) for name in ['title', 'plain', 'tldr']},
        **{name: {'type': 'array', 'minItems': 1, 'maxItems': 30, 'items': dict(_TEXT)}
           for name in ['findings', 'risks']},
        'glossary': {'type': 'array', 'minItems': 1, 'maxItems': 100,
                     'items': {'type': 'array', 'minItems': 2, 'maxItems': 2,
                               'items': dict(_TEXT)}},
        # Codex Structured Outputs rejects uniqueItems; _cover still enforces it.
        'related': {'type': 'array', 'maxItems': 5,
                    'items': {'type': 'string', 'enum': BOARDS}},
        'limitations': {'type': 'string', 'maxLength': 20000},
    },
    'required': ['title', 'plain', 'tldr', 'findings', 'risks', 'glossary', 'related', 'limitations'],
}
_TOKENS = {'TITLE', 'TYPE', 'DATE', 'PLAIN', 'TLDR', 'KEY_FINDINGS', 'BODY',
           'LIMITATION_BLOCK', 'GLOSSARY', 'RISKS', 'SOURCES', 'SOURCE_COUNT', 'MASTHEAD_BOARDS'}
_PLACEHOLDER = re.compile(r'\{\{([A-Z_]+)\}\}')
_TAGS = set('h2 h3 h4 h5 h6 p ul ol li table thead tbody tfoot tr th td caption '
            'div section span small strong em b i u s sub sup mark code pre '
            'blockquote a dl dt dd br hr'.split())
_VOID = {'br', 'hr'}
_ATTRS = {'a': {'href'}, 'th': {'colspan', 'rowspan', 'scope'},
          'td': {'colspan', 'rowspan'}, 'ol': {'start'}}


def _text(value, *, empty=False):
    if not isinstance(value, str) or len(value) > 20000 or (not empty and not value.strip()):
        raise ValueError('Invalid cover text')
    if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', value):
        raise ValueError('Control character in cover')
    try: value.encode('utf-8')
    except UnicodeError as error: raise ValueError('Invalid cover encoding') from error


def _cover(value):
    if not isinstance(value, dict) or set(value) != set(COVER_SCHEMA['required']):
        raise ValueError('Incomplete or unexpected cover fields')
    for name in ['title', 'plain', 'tldr', 'limitations']:
        _text(value[name], empty=name == 'limitations')
    if '\n' in value['title'] or '\r' in value['title']:
        raise ValueError('Cover title must be one line')
    for name in ['findings', 'risks', 'glossary', 'related']:
        spec = COVER_SCHEMA['properties'][name]
        items = value[name]
        if not isinstance(items, list) or not spec.get('minItems', 0) <= len(items) <= spec['maxItems']:
            raise ValueError('Invalid cover list')
        for item in items:
            if name == 'glossary':
                if not isinstance(item, list) or len(item) != 2:
                    raise ValueError('Invalid glossary pair')
                for part in item: _text(part)
            else: _text(item)
    if any(item not in BOARDS for item in value['related']) or len(set(value['related'])) != len(value['related']):
        raise ValueError('Invalid related boards')
    return value


def validate_cover(text):
    """Validate exact JSON metadata; duplicate keys cannot silently win."""
    if not isinstance(text, str) or len(text.encode('utf-8')) > 2_000_000:
        raise ValueError('Invalid cover JSON')
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value: raise ValueError('Duplicate cover key')
            value[key] = item
        return value
    try: value = json.loads(text, object_pairs_hook=unique)
    except (json.JSONDecodeError, UnicodeError) as error:
        raise ValueError('Invalid cover JSON') from error
    return _cover(value)


def _url(value):
    if not isinstance(value, str) or not value or re.search(r'[\s\x00-\x1f\x7f<>"`\\]', value):
        raise ValueError('Invalid source URL')
    if value.startswith('#'):
        if not re.fullmatch(r'#[\w.-]+', value): raise ValueError('Invalid fragment URL')
        return value
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in ['http', 'https'] or not parsed.hostname or not parsed.netloc:
            raise ValueError('Source URL must be http(s)')
        if parsed.username is not None or parsed.password is not None:
            raise ValueError('Credentials in source URL')
        parsed.port
    except (ValueError, UnicodeError) as error: raise ValueError('Invalid source URL') from error
    # Give HTML and Markdown the same spelling, including apostrophes and Unicode.
    return quote(parsed.scheme + value[len(parsed.scheme):], safe='/:#?[]@!$&()*+,;=%-._~')


class _Fragment(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.output, self.headings = [], [], []
        self.heading, self.anchor = None, None
        self.links = {}

    def handle_starttag(self, tag, attrs):
        if tag not in _TAGS: raise ValueError('Unsupported report tag: ' + tag)
        if tag == 'h2' and self.stack: raise ValueError('Stock heading must be top level')
        if tag == 'a' and self.anchor is not None: raise ValueError('Nested source anchor')
        if tag == 'a' and self.heading is not None: raise ValueError('Source link in heading')
        attrs = [(name, _url(value) if name == 'href' else value) for name, value in attrs]
        allowed = {'class', 'id', 'title'} | _ATTRS.get(tag, set())
        names = [name for name, value in attrs]
        if len(set(names)) != len(names): raise ValueError('Duplicate HTML attribute')
        for name, value in attrs:
            if name not in allowed or value is None: raise ValueError('Unsupported HTML attribute')
            if re.search(r'[\x00-\x1f\x7f]', value): raise ValueError('Control in HTML attribute')
            if name == 'href': _url(value)
            if name in ['rowspan', 'colspan'] and not re.fullmatch(r'[1-9]\d{0,2}', value):
                raise ValueError('Invalid table span')
            if name == 'start' and not re.fullmatch(r'-?\d{1,6}', value):
                raise ValueError('Invalid list start')
        if tag == 'a':
            href = dict(attrs).get('href')
            if href is None: raise ValueError('Missing source URL')
            self.anchor = [href, []]
        if tag == 'h2': self.heading = []
        self.output.append('<' + tag + ''.join(' ' + name + '="' + html.escape(value, quote=True) + '"'
                                              for name, value in attrs) + '>')
        if tag not in _VOID: self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        if tag not in _VOID: raise ValueError('Unexpected self-closing report tag')
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1] != tag: raise ValueError('Unbalanced report HTML')
        self.stack.pop()
        self.output.append('</' + tag + '>')
        if tag == 'h2':
            title = ''.join(self.heading).strip()
            match = re.fullmatch(r'([A-M])[.．、\s]+(.+)', title, flags=re.S)
            if not match: raise ValueError('Missing stock heading prefix or title')
            self.headings.append(match.group(1))
            # Internal framework letters and heading formatting do not become public text.
            start = next(i for i in range(len(self.output)-1, -1, -1) if self.output[i].startswith('<h2'))
            self.output[start:] = [self.output[start], html.escape(match.group(2).strip()), '</h2>']
            self.heading = None
        if tag == 'a':
            url, text = self.anchor
            if not url.startswith('#'):
                self.links.setdefault(url, re.sub(r'\s+', ' ', ''.join(text)).strip() or url)
            self.anchor = None

    def handle_data(self, data):
        if re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', data):
            raise ValueError('Control character in HTML')
        self.output.append(html.escape(data))
        if self.heading is not None: self.heading.append(data)
        if self.anchor is not None: self.anchor[1].append(data)

    def handle_comment(self, data): raise ValueError('Comments in report fragment')
    def handle_decl(self, decl): raise ValueError('Document declaration in fragment')
    def handle_pi(self, data): raise ValueError('Processing instruction in fragment')
    def unknown_decl(self, data): raise ValueError('Unknown declaration in fragment')

    def parse(self, text, expected):
        if not isinstance(text, str) or not text.strip() or len(text.encode('utf-8')) > 2_000_000:
            raise ValueError('Invalid stock fragment')
        self.feed(text)
        # HTMLParser.close can silently discard a trailing incomplete start tag.
        if self.rawdata: raise ValueError('Incomplete stock fragment markup')
        self.close()
        if self.stack or self.rawdata or self.headings != list(expected):
            raise ValueError('Stock stage headings or HTML incomplete')
        return ''.join(self.output)


def validate_fragment(text, expected):
    """Preflight a stock writing stage before checkpointing, preserving its text."""
    if expected not in ('ABCD', 'EFGHI', 'JKLM'):
        raise ValueError('Unknown stock fragment stage')
    _Fragment().parse(text, expected)
    return text


class _TemplateSafety(HTMLParser):
    """Templates are host-owned, but an unexpected active template fails closed."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []

    def handle_starttag(self, tag, attrs):
        if tag not in _TAGS | {'html', 'head', 'body', 'title', 'meta', 'style', 'header', 'main', 'footer', 'h1'}:
            raise ValueError('Unsupported template tag')
        allowed = {'class', 'id', 'title'} | _ATTRS.get(tag, set())
        if tag == 'html': allowed |= {'lang'}
        if tag == 'meta': allowed |= {'charset', 'name', 'content'}
        names = [name for name, value in attrs]
        if len(names) != len(set(names)): raise ValueError('Duplicate template attribute')
        for name, value in attrs:
            if name not in allowed or value is None:
                raise ValueError('Unsupported template attribute')
            if name == 'href': _url(value)
        if tag not in _VOID | {'meta'}: self.stack.append(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1] != tag: raise ValueError('Unbalanced template HTML')
        self.stack.pop()

    def handle_decl(self, decl):
        if decl.lower() != 'doctype html': raise ValueError('Unsupported template declaration')

    def handle_comment(self, data): raise ValueError('Unexpected template comment')
    def handle_pi(self, data): raise ValueError('Processing instruction in template')
    def unknown_decl(self, data): raise ValueError('Unknown declaration in template')

    def handle_data(self, data):
        if (not self.stack and data.strip()) or '<' in data:
            raise ValueError('Text outside template document or malformed tag')
        if self.stack and self.stack[-1] == 'style':
            css = re.sub(r'/\*.*?\*/', '', data, flags=re.S)
            if '\\' in css or re.search(r'@import\b|url\s*\(|(?:image-set|expression)\s*\(', css, re.I):
                raise ValueError('External or active template CSS')


def _md(value):
    # Cover values are plain text, never Markdown directives or new sections.
    value = re.sub(r'\s+', ' ', value).strip().replace('<', '&lt;').replace('>', '&gt;')
    value = re.sub(r'([\\`*_{}\[\]#+!|])', r'\\\1', value)
    value = re.sub(r'^(-)(?=\s|--)', r'\\\1', value)
    return re.sub(r'^(\d+)([.)])(?=\s)', r'\1\\\2', value)


def assemble_stock(parts, cover, template, date, slug):
    """Assemble research bundle without selecting paths, writing files, or facts."""
    cover = _cover(cover)
    if not isinstance(date, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', date):
        raise ValueError('Invalid host date')
    try: calendar_date.fromisoformat(date)
    except ValueError as error: raise ValueError('Invalid host date') from error
    if not isinstance(slug, str) or len(slug) > 150 or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', slug):
        raise ValueError('Invalid host slug')
    if not isinstance(parts, list) or len(parts) != 3: raise ValueError('Expected three stock stages')
    rendered, links = [], {}
    for text, expected in zip(parts, ['ABCD', 'EFGHI', 'JKLM']):
        parser = _Fragment()
        rendered.append(parser.parse(text, expected))
        for url, label in parser.links.items(): links.setdefault(url, label)
    if not isinstance(template, str) or len(template.encode('utf-8')) > 2_000_000:
        raise ValueError('Invalid report template')
    template = re.sub(r'<!--.*?-->', '', template, flags=re.S)
    template = template.replace('来源清单（按可信度优先级排序）', '来源清单（按正文首次引用顺序）')
    if not re.match(r'\s*<!doctype html>', template, re.I) or not re.search(r'</html>\s*$', template, re.I):
        raise ValueError('Report template must be a complete HTML document')
    if set(_PLACEHOLDER.findall(template)) != _TOKENS:
        raise ValueError('Unexpected or missing report template tokens')
    safety = _TemplateSafety()
    safety.feed(template)
    safety.close()
    if safety.stack or safety.rawdata: raise ValueError('Incomplete report template')
    escape = html.escape
    items = lambda values: ''.join('<li>' + escape(item) + '</li>' for item in values)
    glossary = '<section class="glossary"><h2>名词小抄</h2><dl>' + ''.join(
        '<dt>' + escape(term) + '</dt><dd>' + escape(definition) + '</dd>'
        for term, definition in cover['glossary']) + '</dl></section>'
    values = {
        'TITLE': escape(cover['title']), 'TYPE': '股票', 'DATE': date,
        'PLAIN': escape(cover['plain']), 'TLDR': escape(cover['tldr']),
        'KEY_FINDINGS': items(cover['findings']), 'BODY': '\n'.join(rendered),
        'LIMITATION_BLOCK': ('<div class="limitation">' + escape(cover['limitations']) + '</div>')
                            if cover['limitations'] else '',
        'GLOSSARY': glossary, 'RISKS': items(cover['risks']),
        'SOURCES': ''.join('<li><span class="src-tag">来源</span> <a href="' + escape(url, quote=True)
                           + '">' + escape(label) + '</a></li>' for url, label in links.items()),
        'SOURCE_COUNT': str(len(links)),
        'MASTHEAD_BOARDS': ('<span><b>关联板块</b> ' + ' · '.join(cover['related']) + '</span>')
                           if cover['related'] else '',
    }
    report = _PLACEHOLDER.sub(lambda match: values[match[1]], template)
    if _PLACEHOLDER.search(report): raise ValueError('Unfilled template placeholder')
    # JSON quoted scalars/arrays are valid YAML and cannot switch frontmatter engines.
    yaml = lambda value: json.dumps(value, ensure_ascii=False)
    related = ['[[' + board + ']]' for board in cover['related']]
    notes = ('---\ndate: ' + yaml(date) + '\ntype: 股票\ntags: ' + yaml(['research', '股票'])
             + '\nrelated: ' + yaml(related) + '\nsource_count: ' + str(len(links))
             + '\narchive: ' + yaml('research/' + date + '_' + slug + '/')
             + '\n---\n\n# ' + _md(cover['title']) + '\n\n## 一句话结论\n\n' + _md(cover['tldr'])
             + '\n\n## 核心驱动\n\n' + '\n'.join('- ' + _md(item) for item in cover['findings'])
             + '\n\n## 核心风险\n\n' + '\n'.join('- ' + _md(item) for item in cover['risks']) + '\n')
    if related: notes += '\n## 关联\n\n' + ' · '.join(related) + '\n'
    sources = '# 来源清单\n\n报告日期：' + date + '（北京时间）。来源顺序按正文首次出现，不代表可信度排序。\n\n'
    sources += '\n'.join('- [' + _md(label) + '](<' + url + '>)' for url, label in links.items()) + '\n'
    return {'report_html': report, 'notes_md': notes, 'sources_md': sources, 'evidence': []}

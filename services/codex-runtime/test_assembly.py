import json
from pathlib import Path
import tempfile
import unittest

from assembly import COVER_SCHEMA, assemble_stock, validate_cover, validate_fragment
from bundle import materialize


TEMPLATE = (Path(__file__).resolve().parents[2] /
            '.agents/skills/research/templates/report.html').read_text()


def cover():
    return {'title': '示例公司（123456.SH）', 'plain': '制造设备的公司。',
            'tldr': '未来13周方向震荡，等待披露。', 'findings': ['收入增长。'],
            'risks': ['现金流压力。'], 'glossary': [['毛利率', '营业成本扣除后的比例。']],
            'related': ['机器人'], 'limitations': '信息截止另见正文；尚有信息缺口。'}


def parts():
    return [''.join(f'<h2>{letter}. 章节{letter}</h2><p>正文</p>' for letter in letters)
            for letters in ['ABCD', 'EFGHI', 'JKLM']]


class AssemblyTests(unittest.TestCase):
    def assemble(self, body=None, metadata=None, template=TEMPLATE, date='2026-10-03', slug='example-123456'):
        return assemble_stock(parts() if body is None else body,
                              cover() if metadata is None else metadata, template, date, slug)

    def test_cover_schema_and_validator_require_complete_exact_metadata(self):
        self.assertEqual(set(COVER_SCHEMA['required']), set(cover()))
        self.assertFalse(COVER_SCHEMA['additionalProperties'])
        # The real Codex endpoint rejects uniqueItems with invalid_json_schema.
        # Uniqueness remains enforced by validate_cover below, before checkpointing.
        self.assertNotIn('uniqueItems', COVER_SCHEMA['properties']['related'])
        self.assertEqual(validate_cover(json.dumps(cover())), cover())
        for change in [{'related': ['半导体']}, {'related': ['机器人', '机器人']},
                       {'glossary': [['术语']]}, {'findings': []}, {'risks': [3]},
                       {'title': 'x\n---js'}, {'limitations': None}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_cover(json.dumps({**cover(), **change}))
        for bad in ['[]', '{}', json.dumps({**cover(), 'report_html': 'x'}),
                    json.dumps(cover())[:-1] + ',"title":"duplicate"}']:
            with self.subTest(bad=bad), self.assertRaises(ValueError): validate_cover(bad)

    def test_stage_validator_preserves_original_and_rejects_bad_checkpoint_content(self):
        for body, expected in zip(parts(), ['ABCD', 'EFGHI', 'JKLM']):
            self.assertEqual(validate_fragment(body, expected), body)
        for body, expected in [(parts()[0].replace('<h2>D. 章节D</h2>', ''), 'ABCD'),
                               (parts()[1], 'ABCD'), (parts()[0]+'<script>1</script>', 'ABCD'),
                               (parts()[0], 'ABCDEFGHIJKLM'), (parts()[0], None)]:
            with self.subTest(expected=expected), self.assertRaises(ValueError):
                validate_fragment(body, expected)

    def test_bundle_is_deterministic_materializable_and_has_no_unfilled_tokens(self):
        first = self.assemble()
        self.assertEqual(first, self.assemble())
        self.assertEqual(set(first), {'report_html', 'notes_md', 'sources_md', 'evidence'})
        self.assertEqual(first['evidence'], [])
        self.assertNotRegex(first['report_html'], r'\{\{[A-Z_]+\}\}')
        self.assertIn('<h2>章节A</h2>', first['report_html'])
        self.assertNotIn('<h2>A.', first['report_html'])
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(materialize(first, Path(tmp), 'research'),
                             ['notes.md', 'report.html', 'sources.md'])

    def test_stage_boundaries_missing_duplicate_and_reordered_headings_rejected(self):
        invalid = [parts()[:2], [parts()[0]+parts()[1], '', parts()[2]],
                   [parts()[1], parts()[0], parts()[2]],
                   [parts()[0].replace('B.', 'A.'), *parts()[1:]],
                   [parts()[0].replace('<h2>B. 章节B</h2>', ''), *parts()[1:]],
                   [parts()[0]+'<h2>额外章节</h2>', *parts()[1:]]]
        for bad in invalid:
            with self.subTest(bad=bad), self.assertRaises(ValueError): self.assemble(body=bad)

    def test_heading_text_is_parsed_not_matched_inside_comments_or_attributes(self):
        good=parts(); good[0]=good[0].replace('A. 章节A', '<strong>A．</strong> 章节A')
        self.assertIn('<h2>章节A</h2>', self.assemble(body=good)['report_html'])
        for fake in ['<!-- <h2>A. x</h2> -->', '<p title="<h2>A. x</h2>">x</p>']:
            bad=parts();bad[0]=bad[0].replace('<h2>A. 章节A</h2>', fake)
            with self.subTest(fake=fake), self.assertRaises(ValueError): self.assemble(body=bad)

    def test_heading_anchor_ids_preserved_and_heading_sources_cannot_be_lost(self):
        body=parts();body[0]=body[0].replace('<h2>A.', '<h2 id="snapshot">A.')
        result=self.assemble(body=body)
        self.assertIn('<h2 id="snapshot">章节A</h2>', result['report_html'])
        body=parts();body[0]=body[0].replace('A. 章节A',
                  'A. <a href="https://example.com">章节A</a>')
        with self.assertRaises(ValueError): self.assemble(body=body)

    def test_active_or_malformed_html_fails_closed(self):
        attacks=['<script>alert(1)</script>', '<iframe src="https://example.com"></iframe>',
                 '<svg/onload=1>', '<p title="a>b"onerror=1>x</p>',
                 '<a href="https://example.com" onclick="1">x</a>',
                 '<style>@import "https://example.com";</style>',
                 '<img src="https://example.com">', '<form>x</form>',
                 '<meta http-equiv="refresh" content="0;url=https://example.com">',
                 '<p style="background:url(https://example.com)">x</p>',
                 '<p><strong>x</p></strong>', '<p hidden>x</p>',
                 '<a href="https://example.com" href="javascript:1">x</a>',
                 '<a href="https://example.com"><a href="https://evil.com">x</a></a>',
                 '<h2>A. nested</h2>', '<!-- unfinished', '<p', '<script']
        for attack in attacks:
            bad=parts();bad[0]+=attack
            with self.subTest(attack=attack), self.assertRaises(ValueError): self.assemble(body=bad)

    def test_source_protocols_and_url_ambiguities_rejected(self):
        for url in ['javascript:1', 'java&#x73;cript:1', 'java&#x09;script:1',
                    'data:text/html,x', 'file:///tmp/x', '//example.com', 'https:///missing',
                    'https://user:pass@example.com/x', 'https://example.com\\evil',
                    'https://example.com/white space', 'https://example.com:bad/x']:
            bad=parts();bad[0]+=f'<p><a href="{url}">来源</a></p>'
            with self.subTest(url=url), self.assertRaises(ValueError): self.assemble(body=bad)

    def test_sources_deduplicate_and_match_body_with_neutral_labels(self):
        body=parts();body[0]+='<p><a href="https://example.com/p?a=1&amp;b=2">标题[一]</a></p>'
        body[1]+='<p><a href="https://example.com/p?a=1&amp;b=2">重复</a> <a href="#section">内部</a></p>'
        body[2]+='<p><a href="http://example.org/a_(b)"><strong>另一来源</strong></a></p>'
        result=self.assemble(body=body)
        self.assertIn('source_count: 2', result['notes_md'])
        self.assertIn('<span class="src-tag">来源</span>', result['report_html'])
        self.assertNotIn('src-tag src-reg', result['report_html'])
        self.assertEqual(result['sources_md'].count('https://example.com/p?a=1&b=2'), 1)
        self.assertIn('](<http://example.org/a_(b)>)', result['sources_md'])
        self.assertNotIn('#section', result['sources_md'])

    def test_valid_quoted_and_unicode_urls_have_one_canonical_spelling(self):
        body=parts();body[0]+='<p><a href="HTTPS://example.com/报告?q=it\'s">披露</a></p>'
        result=self.assemble(body=body)
        canonical='https://example.com/%E6%8A%A5%E5%91%8A?q=it%27s'
        self.assertIn('href="'+canonical+'"', result['report_html'])
        self.assertIn('](<'+canonical+'>)', result['sources_md'])

    def test_metadata_html_and_yaml_are_escaped_and_date_is_host_owned(self):
        meta=cover();meta.update(title='公司: "引号" & <b>（ZZ）', plain='<script>bad</script>',
                               tldr='总结 [链接](javascript:1)\n---\ntype: 人物')
        result=self.assemble(metadata=meta, date='2026-11-04', slug='other-zz')
        self.assertIn('&lt;script&gt;bad&lt;/script&gt;', result['report_html'])
        self.assertIn('archive: "research/2026-11-04_other-zz/"', result['notes_md'])
        self.assertIn('related: ["[[机器人]]"]', result['notes_md'])
        self.assertIn('\\[链接\\]', result['notes_md'])
        self.assertNotIn('\n---\ntype: 人物', result['notes_md'])
        self.assertNotIn('688017', result['notes_md'])

    def test_empty_related_and_limitations_do_not_invent_boards_or_cutoff(self):
        meta=cover();meta.update(related=[], limitations='')
        result=self.assemble(metadata=meta)
        self.assertNotIn('<b>关联板块</b>', result['report_html'])
        self.assertNotIn('<div class="limitation">', result['report_html'])
        self.assertIn('related: []', result['notes_md'])
        self.assertNotIn('行情截至', result['sources_md'])

    def test_plain_company_punctuation_survives_note_metadata(self):
        meta=cover();meta.update(title='AT&T (NYSE: T)', tldr='收入增长 (同比5%)，等待披露。')
        result=self.assemble(metadata=meta)
        self.assertIn('# AT&T (NYSE: T)\n', result['notes_md'])
        self.assertIn('收入增长 (同比5%)，等待披露。', result['notes_md'])

    def test_host_date_slug_and_template_contract_fail_closed(self):
        for date, slug in [('2026-02-30', 'x'), ('20261003', 'x'), ('2026-10-03', '../x'),
                           ('2026-10-03', 'a/b'), ('2026-10-03', '2026-10-03_x')]:
            with self.subTest(date=date, slug=slug), self.assertRaises(ValueError):
                self.assemble(date=date, slug=slug)
        for template in [TEMPLATE.replace('{{BODY}}',''), TEMPLATE+'{{UNKNOWN}}',
                         TEMPLATE+'<script>alert(1)</script>',
                         TEMPLATE.replace('<style>', '<style>@impor\\74 "https://example.com/x.css";'),
                         TEMPLATE.replace('<style>', '<style>p{background:image-set("https://example.com/x")}'),
                         TEMPLATE.replace('<body>', '<body background="https://example.com/pixel">'),
                         TEMPLATE + '<p',
                         TEMPLATE.replace('<body>', '<body onload="1">')]:
            with self.subTest(template=template), self.assertRaises(ValueError):
                self.assemble(template=template)


if __name__ == '__main__': unittest.main()

"""End-to-end test of index.html in headless Chromium.
The page is served over HTTP from the repo root. The archive API (/api/*) is always mocked from
test-vectors.json. With --offline the drand relays are mocked too (real vectors for their rounds,
self-consistent synthetic rounds otherwise), so the run is deterministic and needs no network.
Exercises live ticker, feed, update, capture, timer, check, reveal, export, and the verify tab."""
import json, os, sys, time, hashlib, threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VEC = json.load(open(os.path.join(ROOT, 'test-vectors.json')))
ROUNDS = {v['round']: v for v in VEC['rounds']}
LATEST = VEC['rounds'][-1]            # round 33470004 -> N 3307786713929837, p 47795929, q 69206453
FIRST = ROUNDS[20000000]              # served as 'latest' once, so the feed can advance
OFFLINE = '--offline' in sys.argv
GENESIS, PERIOD = 1692803367, 3
def round_time(r): return GENESIS + (r - 1) * PERIOD
N_OF = {1: '8766449459018651', 20000000: '2842566290086427', 33470004: '3307786713929837'}

def fake_round(r):
    """A synthetic round with randomness = SHA-256(signature); never passes BLS, fine for listings."""
    sig = hashlib.sha256(b'sig-%d' % r).digest() + hashlib.sha256(b'sig2-%d' % r).digest()[:16]
    return {'round': r, 'randomness': hashlib.sha256(sig).hexdigest(), 'signature': sig.hex()}

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
httpd = ThreadingHTTPServer(('127.0.0.1', 0), partial(Quiet, directory=ROOT))
threading.Thread(target=httpd.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % httpd.server_address[1]

fails = []
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)

with sync_playwright() as p:
    browser = p.chromium.launch()
    # A non-UTC zone so the local-time branch of the lookup is really exercised.
    ctx = browser.new_context(viewport={'width': 420, 'height': 900}, accept_downloads=True, timezone_id='America/New_York')
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    # an expected 404 from an archive miss (/api/n/...) is logged by Chrome as a resource error; ignore it
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and not ('404' in m.text and '/api/n/' in (m.location or {}).get('url', '')) else None)

    hits = {'n': 0}
    def handle(route, request):
        hits['n'] += 1
        url = request.url
        which = url.rsplit('/public/', 1)[1]
        if which == 'latest':
            body = FIRST if hits['n'] == 1 else LATEST
        elif which.isdigit() and int(which) in ROUNDS:
            body = ROUNDS[int(which)]
        elif which.isdigit() and int(which) >= 1:
            body = fake_round(int(which))
        else:
            return route.fulfill(status=404, body='not found')
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    if OFFLINE:
        page.route('**/public/**', handle)

    # archive API mock: the archive holds exactly the three test-vector rounds
    def handle_api(route, request):
        path = request.url.split('/api/', 1)[1]
        def js(body, status=200): route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        if path == 'status':
            return js({'count': 3, 'first': 1, 'last': 33470004, 'firstTime': round_time(1), 'lastTime': round_time(33470004)})
        if path.startswith('n/'):
            for r, n in N_OF.items():
                if n == path[2:]:
                    rows = [ROUNDS[r]]
                    if r == 1: rows.append(fake_round(5))      # a bogus archive row that must be ignored
                    return js({'n': n, 'rounds': rows})
            return js({'error': 'not in archive'}, 404)
        if path.startswith('range?'):
            q = dict(kv.split('=') for kv in path[6:].split('&'))
            a, b = int(q['from']), int(q['to'])
            return js({'from': a, 'to': b, 'rounds': [ROUNDS[r] for r in sorted(ROUNDS, reverse=True) if a <= r <= b]})
        return js({'error': 'not found'}, 404)
    page.route('**/api/**', handle_api)

    page.goto(BASE + '/index.html')
    page.wait_for_function("document.getElementById('captureBtn').disabled === false", timeout=20000)
    check(page.inner_text('#liveSig') == 'signature verified', 'live round shows verified signature')
    live_round = page.inner_text('#liveRound')
    live_n = page.inner_text('#liveN').replace(' ', '')
    check(len(live_n) == 16 and live_n.isdigit(), f'live N is 16 digits ({live_n})')
    check(len(page.inner_text('#liveWords').split()) == 5, 'live N shown as 5 words')
    if OFFLINE:
        check(live_round == str(FIRST['round']), 'first round shown matches mocked latest')
        check(live_n == '2842566290086427', 'first N matches test vector')
    check(page.inner_text('#updateBtn') == 'Up to date' and page.is_disabled('#updateBtn'), 'update button idle when nothing newer')
    check(page.locator('#feedList li').count() == 1, 'feed starts with the first round')

    # the focused number stays while newer rounds join the feed; Update moves to the newest
    page.wait_for_function("document.querySelectorAll('#feedList li').length >= 2", timeout=15000)
    check(page.inner_text('#liveRound') == live_round and page.inner_text('#liveN').replace(' ', '') == live_n, 'focused number unchanged after a new round arrived')
    feed_rounds = [int(m.inner_text().split('round ')[1].split(' ')[0]) for m in page.locator('#feedList li .meta').all()]
    check(feed_rounds == sorted(feed_rounds, reverse=True) and feed_rounds[0] > int(live_round), f'feed is newest first ({feed_rounds})')
    check(page.locator('#feedList li.focused').count() == 1 and page.inner_text('#feedList li.focused .n').replace(' ', '') == live_n, 'focused round is marked in the feed')
    check(page.inner_text('#updateBtn').startswith('Update (') and not page.is_disabled('#updateBtn'), 'update button offers the newer round')
    newest_n = page.inner_text('#feedList li:first-child .n').replace(' ', '')
    page.click('#updateBtn')
    check(page.inner_text('#liveN').replace(' ', '') == newest_n and page.inner_text('#liveRound') == str(feed_rounds[0]), 'update focuses the newest round')
    check(page.inner_text('#updateBtn') == 'Up to date', 'update button idle again')
    if OFFLINE:
        check(newest_n == '3307786713929837', 'newest N matches test vector')
    live_round = page.inner_text('#liveRound')
    live_n = page.inner_text('#liveN').replace(' ', '')

    # capture
    page.click('#captureBtn')
    check(not page.is_visible('#liveCard') and not page.is_visible('#feedCard') and page.is_visible('#capCard'), 'capture shows captured card')
    cap_n = page.inner_text('#capN').replace(' ', '')
    check(cap_n == live_n, 'captured N equals live N')
    check('Reveal' in page.inner_text('#revealBox summary'), 'reveal is collapsed by default')
    check(page.inner_text('#capReveal').strip() == '', 'factors not in DOM before reveal')
    time.sleep(0.6)
    check(float(page.inner_text('#capTimer').split()[0]) >= 0.5, 'timer is running')

    # wrong answer, then correct answer (digits), then words
    page.fill('#answer', '12345678'); page.press('#answer', 'Enter')
    check(page.inner_text('#capResult').startswith('Wrong'), 'wrong digit factor rejected')
    # get the factors the way a tester would: through reveal
    page.click('#revealBox summary')
    page.wait_for_function("document.getElementById('capReveal').textContent.length > 0", timeout=3000)
    reveal = page.inner_text('#capReveal')
    check('×' in reveal, 'reveal shows p × q')
    pstr = reveal.split()[0]; qstr = reveal.split('×')[1].split()[0]
    pw = reveal.split('(')[1].split(')')[0]
    check(int(pstr) * int(qstr) == int(cap_n), 'revealed factors multiply to N')
    page.fill('#answer', pstr); page.press('#answer', 'Enter')
    check(page.inner_text('#capResult').startswith('Correct'), 'correct digit factor accepted')
    t1 = page.inner_text('#capTimer'); time.sleep(0.4); t2 = page.inner_text('#capTimer')
    check(t1 == t2, 'timer stops on first correct answer')
    page.fill('#answer', pw); page.press('#answer', 'Enter')
    check(page.inner_text('#capResult').startswith('Correct'), 'correct word factor accepted')
    page.fill('#answer', f'{pstr} x {qstr}'); page.press('#answer', 'Enter')
    check(page.inner_text('#capResult').startswith('Correct'), 'two factors accepted')
    rows = page.locator('#logTable tbody tr').count()
    check(rows == 4, f'session log has 4 entries ({rows})')

    # export
    with page.expect_download() as dl:
        page.click('#exportBtn')
    path = dl.value.path()
    exp = json.load(open(path))
    check(len(exp['entries']) == 4 and exp['entries'][1]['correct'] and 'signature' in exp['entries'][0]['beacon'], 'export JSON has entries with beacon data')

    # back to live
    page.click('#releaseBtn')
    check(page.is_visible('#liveCard') and page.is_visible('#feedCard') and not page.is_visible('#capCard'), 'back to live')

    # verify tab: by round number
    page.click('nav [data-tab=verify]')
    page.wait_for_function("document.getElementById('vArchive').textContent.startsWith('Archive: 3 rounds, from 1 ')", timeout=5000)
    check('to 33470004 (2026-10-28 18:49:36 UTC)' in page.inner_text('#vArchive'), 'archive coverage is shown')
    page.fill('#vQuery', '1'); page.press('#vQuery', 'Enter')
    page.wait_for_function("!document.getElementById('vCard').hidden", timeout=15000)
    check(page.inner_text('#vrN').replace(' ', '') == '8766449459018651', 'verify by round number recomputes round 1 N from spec')
    check(page.inner_text('#vrSig') == 'BLS signature valid', 'verify tab: signature valid')
    check(page.inner_text('#vLookupMsg').startswith('Genuine: round 1 was the number showing from 2023-08-23 15:09:27 UTC for 3 s.'), 'round note names the time window')
    page.fill('#vAnswer', '90234649'); page.press('#vAnswer', 'Enter')
    check(page.inner_text('#vResult').startswith('Correct'), 'factor check on a verified round works')
    page.fill('#vAnswer', 'expose angry similar'); page.press('#vAnswer', 'Enter')
    check(page.inner_text('#vResult').startswith('Wrong'), 'wrong word factor rejected (and a word containing x is one word: ' + page.inner_text('#vResult') + ')')
    page.fill('#vAnswer', '90234649x97151699'); page.press('#vAnswer', 'Enter')
    check(page.inner_text('#vResult').startswith('Correct'), 'x between digits still separates factors')

    # by 16-digit number and by 5 words, through the archive
    def verify_query(q):
        page.evaluate("document.getElementById('vLookupMsg').textContent = ''; document.getElementById('vErr').textContent = ''")
        page.fill('#vQuery', q); page.click('#vFetchBtn')
        page.wait_for_function("document.getElementById('vLookupMsg').textContent.length > 0 || (document.getElementById('vErr').textContent.length > 0 && !document.getElementById('vErr').textContent.includes('…'))", timeout=15000)
        return page.inner_text('#vLookupMsg'), page.inner_text('#vErr')
    msg, err = verify_query('2842566290086427')
    check(msg.startswith('Genuine: round 20000000 was the number showing from 2025-07-18 01:49:24 UTC') and 'archive' in msg, f'16-digit number is traced to its round via the archive ({msg or err})')
    check(page.inner_text('#vrN').replace(' ', '') == '2842566290086427' and page.inner_text('#vrSig') == 'BLS signature valid', 'archive row is re-verified in the browser')
    check(page.input_value('#vAnswer') == '' and page.inner_text('#vResult') == '', 'factor check is reset for the new number')
    page.fill('#vAnswer', '66752887 42583421'); page.press('#vAnswer', 'Enter')
    check(page.inner_text('#vResult').startswith('Correct'), 'both factors accepted for the traced number')
    msg, err = verify_query('before network eager tiny drop')
    check(msg.startswith('Genuine: round 20000000'), f'five words are traced to the same round ({msg or err})')
    msg, err = verify_query('Before NETWORK eage tiny drop')
    check(msg.startswith('Genuine: round 20000000'), f'words are case-insensitive and accept 4-letter prefixes ({msg or err})')
    msg, err = verify_query('8766449459018651')
    check(msg.startswith('Genuine: round 1 ') and "row for round 5 failed verification and was ignored" in msg, f'bogus archive row is ignored, genuine one shown ({msg or err})')
    page.fill('#vAnswer', 'dinner expose angry'); page.press('#vAnswer', 'Enter')
    check(page.inner_text('#vResult').startswith('Wrong'), 'words containing x parse as words')
    page.fill('#vAnswer', 'accident gown swamp x 97151699'); page.press('#vAnswer', 'Enter')
    check(page.inner_text('#vResult').startswith('Wrong — product'), 'a standalone x separates a word factor from a digit factor: ' + page.inner_text('#vResult'))
    msg, err = verify_query('1234567890123457')
    check(err.startswith('this number is not in the archive.') and 'covers rounds 1 to 33470004' in err, f'unknown number explains archive coverage ({err})')
    msg, err = verify_query('before network eager tiny')
    check('5 words' in err, 'four words are rejected')
    msg, err = verify_query('hello world foo bar baz')
    check('unknown word' in err, 'non-wordlist words are rejected')
    msg, err = verify_query('12x34')
    check(err.startswith('enter a round number'), 'garbage is rejected')

    # offline JSON with tampered signature
    page.locator('#tab-verify details').last.locator('summary').click()
    bad = dict(ROUNDS[1]); bad['signature'] = ROUNDS[20000000]['signature']
    page.fill('#vJson', json.dumps(bad)); page.click('#vJsonBtn')
    check(page.inner_text('#vrSig') == 'BLS signature INVALID', 'tampered signature flagged INVALID')
    check(page.inner_text('#vrRand') == 'randomness MISMATCH', 'randomness mismatch flagged')
    check(page.inner_text('#vLookupMsg').startswith('Round 1 failed verification'), 'note says not to trust a failed round')
    page.fill('#vJson', json.dumps(ROUNDS[20000000])); page.click('#vJsonBtn')
    check(page.inner_text('#vrN').replace(' ', '') == '2842566290086427', 'pasted JSON for round 20000000 verifies and derives N')

    # time range: rounds 19999999..20000002 around a vector round (UTC)
    t = round_time(20000000)
    utcs = lambda u: time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(u))
    def lookup_range(a, b):
        page.evaluate("document.getElementById('vRangeMsg').textContent = ''")
        page.fill('#vFrom', a); page.fill('#vTo', b); page.click('#vRangeBtn')
        page.wait_for_function("document.getElementById('vRangeMsg').textContent.length > 0 || (document.getElementById('vRangeErr').textContent.length > 0 && !document.getElementById('vRangeErr').textContent.includes('…'))", timeout=60000)
        return page.inner_text('#vRangeMsg'), page.inner_text('#vRangeErr')
    page.select_option('#vTz', 'utc')
    msg, err = lookup_range(utcs(t - 3), utcs(t + 8))
    rows = page.locator('#vRangeList li')
    check(rows.count() == 4 and 'round 20000002' in rows.nth(0).inner_text() and 'round 19999999' in rows.nth(3).inner_text(), f'range lists 4 rounds newest first ({msg} / {err})')
    check(msg.startswith('4 rounds, 2025-07-18 01:49:21 to 2025-07-18 01:49:33 UTC. 1 from the archive, 3 from the relays.'), f'range message counts sources ({msg})')
    vec_row = page.locator('#vRangeList li', has_text='round 20000000')
    check(vec_row.locator('.n').inner_text().replace(' ', '') == '2842566290086427' and vec_row.locator('.w').inner_text() == 'before network eager tiny drop', 'archive round shows its number and words')
    check(len(rows.nth(0).locator('.n').inner_text().replace(' ', '')) == 16, 'relay-fetched round shows a 16-digit number')
    page.evaluate("document.getElementById('vLookupMsg').textContent = ''")
    vec_row.locator('[data-verify]').click()
    page.wait_for_function("document.getElementById('vLookupMsg').textContent.length > 0", timeout=15000)
    check(page.inner_text('#vLookupMsg').startswith('Genuine: round 20000000') and page.input_value('#vQuery') == '20000000', 'verify button on a row verifies that round')
    # local time must agree once the browser's offset is applied
    offset = page.evaluate('new Date(%d).getTimezoneOffset() * 60' % (t * 1000))
    check(offset != 0, f'browser runs in a non-UTC zone (offset {offset} s)')
    page.select_option('#vTz', 'local')
    msg, err = lookup_range(utcs(t - 3 - offset), utcs(t + 8 - offset))
    check(page.locator('#vRangeList li').count() == 4 and msg.startswith('4 rounds, 2025-07-18 01:49:21'), f'local-time range resolves to the same rounds ({msg})')
    page.select_option('#vTz', 'utc')
    # cap at 100 rounds
    msg, err = lookup_range(utcs(t), utcs(t + 3600))
    check(page.locator('#vRangeList li').count() == 100 and 'limited to 100 rounds, 5 minutes' in msg, f'hour-long range is capped at 100 rounds ({msg[:120]})')
    # bad ranges
    msg, err = lookup_range(utcs(t + 8), utcs(t))
    check('before its start' in err, 'reversed range is refused')
    msg, err = lookup_range('2099-01-01T12:34:56', '2099-01-02T12:34:56')
    check('future' in err, 'future range is refused')
    msg, err = lookup_range('2020-01-01T12:34:56', '2020-01-02T12:34:56')
    check('quicknet started' in err, 'range before genesis is refused')

    # dark mode render + screenshots
    page.screenshot(path=os.path.join(HERE, 'shot-verify.png'))
    page.click('nav [data-tab=live]')
    page.screenshot(path=os.path.join(HERE, 'shot-live.png'))
    page.emulate_media(color_scheme='dark'); page.screenshot(path=os.path.join(HERE, 'shot-live-dark.png'))
    check(not errors, 'no console/page errors: ' + '; '.join(errors)[:300])
    browser.close()

print('\n%d failures' % len(fails))
sys.exit(1 if fails else 0)

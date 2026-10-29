"""End-to-end test of index.html in headless Chromium.
Serves beacon rounds from test-vectors.json via request interception (so it runs offline and
deterministically), exercises live ticker, capture, timer, check, reveal, export, and verify tab."""
import json, os, sys, time
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
VEC = json.load(open(os.path.join(ROOT, 'test-vectors.json')))
ROUNDS = {v['round']: v for v in VEC['rounds']}
LATEST = VEC['rounds'][-1]            # round 33470004 -> N 3307786713929837, p 47795929, q 69206453
OFFLINE = '--offline' in sys.argv

fails = []
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 420, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)

    hits = {'n': 0}
    def handle(route, request):
        hits['n'] += 1
        url = request.url
        which = url.rsplit('/public/', 1)[1]
        if which == 'latest':
            body = LATEST
        elif which.isdigit() and int(which) in ROUNDS:
            body = ROUNDS[int(which)]
        else:
            return route.fulfill(status=404, body='not found')
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    if OFFLINE:
        page.route('**/public/**', handle)

    page.goto('file://' + os.path.join(ROOT, 'index.html'))
    page.wait_for_function("document.getElementById('captureBtn').disabled === false", timeout=20000)
    check(page.inner_text('#liveSig') == 'signature verified', 'live round shows verified signature')
    live_round = page.inner_text('#liveRound')
    live_n = page.inner_text('#liveN').replace(' ', '')
    check(len(live_n) == 16 and live_n.isdigit(), f'live N is 16 digits ({live_n})')
    check(len(page.inner_text('#liveWords').split()) == 5, 'live N shown as 5 words')
    if OFFLINE:
        check(live_round == str(LATEST['round']), 'live round matches mocked latest')
        check(live_n == '3307786713929837', 'live N matches test vector')

    # capture
    page.click('#captureBtn')
    check(not page.is_visible('#liveCard') and page.is_visible('#capCard'), 'capture shows captured card')
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
    check(page.is_visible('#liveCard') and not page.is_visible('#capCard'), 'back to live')

    # verify tab: fetch round 1
    page.click('nav [data-tab=verify]')
    page.fill('#vRound', '1'); page.click('#vFetchBtn')
    page.wait_for_function("!document.getElementById('vCard').hidden", timeout=15000)
    check(page.inner_text('#vrN').replace(' ', '') == '8766449459018651', 'verify tab recomputes round 1 N from spec')
    check(page.inner_text('#vrSig') == 'BLS signature valid', 'verify tab: signature valid')
    page.fill('#vAnswer', '90234649'); page.press('#vAnswer', 'Enter')
    check(page.inner_text('#vResult').startswith('Correct'), 'verify tab checker works')
    # offline JSON with tampered signature
    bad = dict(ROUNDS[1]); bad['signature'] = ROUNDS[20000000]['signature']
    page.fill('#vJson', json.dumps(bad)); page.click('#vJsonBtn')
    check(page.inner_text('#vrSig') == 'BLS signature INVALID', 'tampered signature flagged INVALID')
    check(page.inner_text('#vrRand') == 'randomness MISMATCH', 'randomness mismatch flagged')
    page.fill('#vJson', json.dumps(ROUNDS[20000000])); page.click('#vJsonBtn')
    check(page.inner_text('#vrN').replace(' ', '') == '2842566290086427', 'pasted JSON for round 20000000 verifies and derives N')

    # dark mode render + screenshots
    page.screenshot(path=os.path.join(HERE, 'shot-verify.png'))
    page.click('nav [data-tab=live]')
    page.screenshot(path=os.path.join(HERE, 'shot-live.png'))
    page.emulate_media(color_scheme='dark'); page.screenshot(path=os.path.join(HERE, 'shot-live-dark.png'))
    check(not errors, 'no console/page errors: ' + '; '.join(errors)[:300])
    browser.close()

print('\n%d failures' % len(fails))
sys.exit(1 if fails else 0)

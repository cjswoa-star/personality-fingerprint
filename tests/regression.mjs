import { chromium } from 'playwright';

const baseURL = process.env.PF_BASE_URL || 'http://127.0.0.1:4173/';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

function assert(cond, msg) { if (!cond) throw new Error(msg); }
async function visible(sel) { return await page.locator(sel).isVisible().catch(() => false); }

async function answerCurrent(choiceIndex = 2) {
  const choices = page.locator('#choiceList .choiceCard');
  const count = await choices.count();
  assert(count >= 5, `선택지가 부족합니다: ${count}`);
  await choices.nth(Math.min(choiceIndex, count - 1)).click();
  await page.locator('#nextBtn').click();
  if (await visible('#transition')) await page.locator('#checkpointContinue').click();
}

async function runSelf() {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    REMOTE_BRIDGE.attempted = true;
    REMOTE_BRIDGE.ready = false;
    REMOTE_BRIDGE.error = 'qa-offline';
  });
  const counts = await page.evaluate(() => ({ self: SELF_TOTAL, bfi: BFI_ITEMS.length, rel: REL_ITEMS.length, scene: SCENARIOS.length, obs: BFI_OBSERVER.length + OBS_REL_ITEMS.length }));
  assert(counts.self === 114 && counts.bfi === 60 && counts.rel === 39 && counts.scene === 15 && counts.obs === 78, `문항 수 불일치: ${JSON.stringify(counts)}`);
  await page.fill('#selfName', '자동검수');
  await page.uncheck('#autoAdvanceStart');
  await page.click('button:has-text("내 성격지문 시작하기")');
  for (let i = 0; i < 114; i++) await answerCurrent(i % 5);
  assert(await visible('#selfResult'), '본인 최종 결과 화면이 열리지 않았습니다.');
  const saved = await page.evaluate(() => !!localStorage.getItem(LAST_SELF_KEY));
  assert(saved, '최근 결과가 localStorage에 저장되지 않았습니다.');

  let stateText = await page.locator('#dashObserver').innerText();
  assert(stateText.includes('0명'), '타인응답 0명 상태표시가 없습니다.');

  await page.evaluate(() => {
    const facets = Object.fromEntries(Object.entries(profile.facets).map(([k,v]) => [k,v]));
    const relations = Object.fromEntries(OBS_REL_KEYS.map(k => [k, profile.relations[k]]));
    observerResults = [{type:'observer', targetName:profile.name, raterName:'A', raterRelation:'친한 친구', facets, relations}];
    renderResultDashboard(profile);
  });
  stateText = await page.locator('#dashObserver').innerText();
  assert(stateText.includes('1명') && stateText.includes('한 사람의 관찰'), '타인응답 1명 상태표시가 올바르지 않습니다.');

  const synth = await page.evaluate(() => {
    const clamp = v => Math.max(1, Math.min(5, v));
    const mk = (name, shift) => ({
      type:'observer', targetName:profile.name, raterName:name, raterRelation:'친한 친구',
      facets:Object.fromEntries(Object.entries(profile.facets).map(([k,v]) => [k,clamp(v+shift)])),
      relations:Object.fromEntries(OBS_REL_KEYS.map(k => [k,clamp(profile.relations[k]+shift)]))
    });
    observerResults=[mk('A',-.7),mk('B',0),mk('C',.7)];
    const z=observerSynthesis(profile);
    renderResultDashboard(profile);
    const similar=new Set(z.similar.map(x=>x.k));
    return {n:z.n, overlap:z.different.filter(x=>similar.has(x.k)).map(x=>x.k), split:z.split.length};
  });
  assert(synth.n === 3, '타인응답 3명 종합이 실패했습니다.');
  assert(synth.overlap.length === 0, `비슷함/다름 중복: ${synth.overlap.join(',')}`);
  stateText = await page.locator('#dashObserver').innerText();
  assert(stateText.includes('3명') && stateText.includes('여러 사람'), '타인응답 여러 명 상태표시가 올바르지 않습니다.');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { REMOTE_BRIDGE.attempted=true; REMOTE_BRIDGE.ready=false; REMOTE_BRIDGE.error='qa-offline'; });
  assert(await visible('#lastResultWrap'), '새로고침 후 최근 결과 안내가 보이지 않습니다.');
  await page.click('button:has-text("최근 결과 다시 열기")');
  assert(await visible('#selfResult'), '최근 결과 복원이 실패했습니다.');
}

async function runObserverOfflineRetry() {
  const token='0123456789abcdef0123456789abcdef0123456789abcdef';
  const url=`${baseURL}?observe=1&target=${encodeURIComponent('자동검수')}&pid=pf_qa_test&token=${token}`;
  await page.goto(url,{waitUntil:'domcontentloaded'});
  await page.evaluate(() => { REMOTE_BRIDGE.attempted=true; REMOTE_BRIDGE.ready=false; REMOTE_BRIDGE.error='qa-offline'; });
  await page.fill('#raterName','검수자');
  await page.click('button:has-text("이 사람에 대해 답하기")');
  for(let i=0;i<78;i++) await answerCurrent((i+1)%5);
  assert(await visible('#obsResult'), '타인 결과 화면이 열리지 않았습니다.');
  await page.waitForFunction(() => !!localStorage.getItem(PENDING_OBSERVER_KEY));
  assert(await visible('#retryObserverBtn'), '전송 실패 후 재전송 버튼이 보이지 않습니다.');
  const pendingBefore=await page.evaluate(()=>!!localStorage.getItem(PENDING_OBSERVER_KEY));
  assert(pendingBefore,'전송 실패한 타인 응답이 임시 저장되지 않았습니다.');

  await page.evaluate(() => {
    REMOTE_BRIDGE.ready=true;
    REMOTE_BRIDGE.attempted=true;
    REMOTE_BRIDGE.auth={currentUser:{uid:'qa-observer'}};
    REMOTE_BRIDGE.db={};
    REMOTE_BRIDGE.api={doc:()=>({}),setDoc:async()=>{},serverTimestamp:()=>({qa:true})};
  });
  await page.click('#retryObserverBtn');
  await page.waitForFunction(() => !localStorage.getItem(PENDING_OBSERVER_KEY));
  const guide=await page.locator('#observerSendGuide').innerText();
  assert(guide.includes('자동으로 연결되었습니다'), '재전송 성공 안내가 없습니다.');
  assert(!(await visible('#retryObserverBtn')), '재전송 성공 후 버튼이 숨겨지지 않았습니다.');

  await page.setViewportSize({width:390,height:844});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
  assert(!overflow,'390px 모바일 화면에서 가로 넘침이 발생했습니다.');
}

try {
  await runSelf();
  await runObserverOfflineRetry();
  assert(errors.length === 0, `브라우저 오류 발생:\n${errors.join('\n')}`);
  console.log('PASS: 성격지문 자동 회귀검수 완료 — self 114 + observer 78 + recovery + offline retry + 0/1/3 observer states');
} finally {
  await browser.close();
}

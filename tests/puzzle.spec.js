const { test, expect } = require('@playwright/test');

const BASE = 'http://localhost:3456';

const MOCK_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

// Wikimedia Commons のモック用定数
const MOCK_TITLE     = 'File:Mock_image.jpg';
const MOCK_THUMB_URL = 'https://upload.wikimedia.org/wikipedia/commons/thumb/mock/512px-Mock_image.jpg';

async function mockImageLoad(page) {
  // Wikimedia Commons API (search + imageinfo) をモック
  await page.route('**commons.wikimedia.org**', async route => {
    const url = route.request().url();
    if (url.includes('list=search')) {
      // 検索 API → 1件のダミー結果を返す
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          query: { search: [{ title: MOCK_TITLE, ns: 6 }] },
        }),
      });
    } else {
      // imageinfo API → ダミーのサムネイル URL を返す
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          query: {
            pages: {
              '12345': {
                title: MOCK_TITLE,
                imageinfo: [{ thumburl: MOCK_THUMB_URL, url: MOCK_THUMB_URL }],
              },
            },
          },
        }),
      });
    }
  });

  // 実際の画像読み込み (upload.wikimedia.org) をモック
  await page.route('**upload.wikimedia.org**', route => {
    route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: Buffer.from(MOCK_PNG_B64, 'base64'),
    });
  });
}

/**
 * ゲーム画面まで遷移するヘルパー。
 * preview countdown を JS 経由でスキップして即ゲーム開始。
 */
async function startGame(page, gridSize = 3) {
  await mockImageLoad(page);
  await page.goto(BASE);
  await page.locator('#prompt-input').fill('test puzzle');
  await page.locator(`.diff-btn[data-size="${gridSize}"]`).click();
  await page.locator('#btn-start').click();

  // ゲーム画面に遷移するまで待つ
  await expect(page.locator('#screen-game')).toBeVisible({ timeout: 10000 });

  // カウントダウンをスキップ（0 にして即シャッフル + タイマー開始をトリガー）
  await page.evaluate(() => {
    document.getElementById('overlay-preview').classList.remove('active');
    const n = State.gridSize;
    State.pieces = shuffle(
      Array.from({ length: n * n }, (_, i) => ({ correctIndex: i }))
    );
    State.isSolved = false;
    State._eventsInitialized = false;
    renderBoard();
    initBoardEvents();
    initResizeObserver();
    Timer.start();
  });
}

// =========================================================
// 1. セットアップ画面
// =========================================================
test.describe('Setup Screen', () => {
  test('初期表示でセットアップ画面が見える', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('#screen-setup')).toBeVisible();
    await expect(page.locator('#screen-loading')).not.toBeVisible();
    await expect(page.locator('#screen-game')).not.toBeVisible();
  });

  test('タイトルが表示される', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('.title')).toContainText('画像パズル');
  });

  test('例チップをクリックするとテキストエリアに入力される', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('.example-chip').first().click();
    const value = await page.locator('#prompt-input').inputValue();
    expect(value.length).toBeGreaterThan(0);
  });

  test('難易度ボタンが切り替わる', async ({ page }) => {
    await page.goto(BASE);
    await expect(page.locator('.diff-btn[data-size="4"]')).toHaveClass(/selected/);
    await page.locator('.diff-btn[data-size="3"]').click();
    await expect(page.locator('.diff-btn[data-size="3"]')).toHaveClass(/selected/);
    await expect(page.locator('.diff-btn[data-size="4"]')).not.toHaveClass(/selected/);
  });

  test('プロンプト空欄のままスタートするとエラー表示', async ({ page }) => {
    await page.goto(BASE);
    await page.locator('#btn-start').click();
    await expect(page.locator('#setup-error')).toBeVisible();
    await expect(page.locator('#setup-error')).toContainText('プロンプト');
  });
});

// =========================================================
// 2. プレビューカウントダウン → ゲーム開始
// =========================================================
test.describe('Preview & Game Start', () => {
  test('スタート後にゲーム画面 + プレビューオーバーレイが表示される', async ({ page }) => {
    await mockImageLoad(page);
    await page.goto(BASE);
    await page.locator('#prompt-input').fill('mountain japan');
    await page.locator('.diff-btn[data-size="3"]').click();
    await page.locator('#btn-start').click();

    await expect(page.locator('#screen-game')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#overlay-preview')).toBeVisible();
  });

  test('カウントダウン終了後にボードがシャッフルされ overlay が消える', async ({ page }) => {
    await mockImageLoad(page);
    await page.goto(BASE);
    await page.locator('#prompt-input').fill('test');
    await page.locator('.diff-btn[data-size="3"]').click();
    await page.locator('#btn-start').click();
    await expect(page.locator('#screen-game')).toBeVisible({ timeout: 10000 });

    // カウントダウンを即終了させる
    await page.evaluate(() => {
      document.getElementById('overlay-preview').classList.remove('active');
      const n = State.gridSize;
      State.pieces = shuffle(Array.from({ length: n*n }, (_, i) => ({ correctIndex: i })));
      State.isSolved = false;
      State._eventsInitialized = false;
      renderBoard(); initBoardEvents(); initResizeObserver(); Timer.start();
    });

    await expect(page.locator('#overlay-preview')).not.toBeVisible();
    await expect(page.locator('#board .piece')).toHaveCount(9);
  });
});

// =========================================================
// 3. ボード描画
// =========================================================
test.describe('Board Rendering', () => {
  test('3×3 で9ピースが描画される', async ({ page }) => {
    await startGame(page, 3);
    await expect(page.locator('#board .piece')).toHaveCount(9);
  });

  test('4×4 で16ピースが描画される', async ({ page }) => {
    await startGame(page, 4);
    await expect(page.locator('#board .piece')).toHaveCount(16);
  });

  test('5×5 で25ピースが描画される', async ({ page }) => {
    await startGame(page, 5);
    await expect(page.locator('#board .piece')).toHaveCount(25);
  });

  test('各ピースに background-image インラインスタイルが設定される', async ({ page }) => {
    await startGame(page, 3);
    // inline style を直接チェック (headless では getComputedStyle が空になる場合がある)
    const bgImage = await page.locator('#board .piece').first()
      .evaluate(el => el.style.backgroundImage);
    expect(bgImage).toContain('url(');
  });

  test('background-origin が border-box に設定される', async ({ page }) => {
    await startGame(page, 3);
    const bgOrigin = await page.locator('#board .piece').first()
      .evaluate(el => el.style.backgroundOrigin);
    expect(bgOrigin).toBe('border-box');
  });

  test('プレビュー画像が表示される', async ({ page }) => {
    await startGame(page, 3);
    const src = await page.locator('#preview-img').getAttribute('src');
    expect(src).toBeTruthy();
  });

  test('タイマー表示が存在する', async ({ page }) => {
    await startGame(page, 3);
    const t = await page.locator('#timer-display').textContent();
    expect(t).toMatch(/\d{2}:\d{2}/);
  });
});

// =========================================================
// 4. グループ計算
// =========================================================
test.describe('Group Computation', () => {
  test('完成状態では全ピースが1つのグループ（同じ groupId）', async ({ page }) => {
    await startGame(page, 3);
    // 全ピースを正解状態に
    await page.evaluate(() => {
      const n = State.gridSize;
      State.pieces = Array.from({ length: n*n }, (_, i) => ({ correctIndex: i }));
      computeGroups();
    });
    const groupIds = await page.evaluate(() => State.pieces.map(p => p.groupId));
    const uniqueGroups = new Set(groupIds);
    expect(uniqueGroups.size).toBe(1);
  });

  test('バラバラ状態では基本的に各ピースが別グループ', async ({ page }) => {
    await startGame(page, 3);
    // 隣接する正解ペアが一切できないよう手動で検証済みの配置
    // pos→correctIndex: 0→4, 1→8, 2→1, 3→6, 4→2, 5→7, 6→5, 7→0, 8→3
    // 水平チェック: (4,8) 8≠5, (8,1) 1≠9, (6,2) 2≠7, (2,7) 7≠3, (5,0) 0≠6, (0,3) 3≠1 → OK
    // 垂直チェック: (4,6) 6≠7, (8,2) 2≠11, (1,5) 5≠4, (6,5) 5≠9, (2,0) 0≠5, (7,3) 3≠10 → OK
    await page.evaluate(() => {
      State.pieces = [
        { correctIndex: 4 }, { correctIndex: 8 }, { correctIndex: 1 },
        { correctIndex: 6 }, { correctIndex: 2 }, { correctIndex: 7 },
        { correctIndex: 5 }, { correctIndex: 0 }, { correctIndex: 3 },
      ];
      computeGroups();
    });
    const groupIds = await page.evaluate(() => State.pieces.map(p => p.groupId));
    const uniqueGroups = new Set(groupIds);
    expect(uniqueGroups.size).toBe(9);
  });

  test('2枚が正しく隣接するとグループIDが一致する', async ({ page }) => {
    await startGame(page, 3);
    // position 0 に correctIndex=0, position 1 に correctIndex=1 → 水平に正しく隣接
    await page.evaluate(() => {
      State.pieces[0] = { correctIndex: 0 };
      State.pieces[1] = { correctIndex: 1 };
      computeGroups();
    });
    const [g0, g1] = await page.evaluate(() => [State.pieces[0].groupId, State.pieces[1].groupId]);
    expect(g0).toBe(g1);
  });

  test('正しく隣接しない2枚はグループIDが異なる', async ({ page }) => {
    await startGame(page, 3);
    await page.evaluate(() => {
      State.pieces[0] = { correctIndex: 0 };
      State.pieces[1] = { correctIndex: 5 }; // 右隣でない
      computeGroups();
    });
    const [g0, g1] = await page.evaluate(() => [State.pieces[0].groupId, State.pieces[1].groupId]);
    expect(g0).not.toBe(g1);
  });
});

// =========================================================
// 5. グループスワップ
// =========================================================
test.describe('Group Swap', () => {
  test('単一ピースのスワップで pieces 配列が入れ替わる', async ({ page }) => {
    await startGame(page, 3);
    // バラバラ配置（グループなし）を明示セット
    await page.evaluate(() => {
      State.pieces = [
        { correctIndex: 4 }, { correctIndex: 8 }, { correctIndex: 1 },
        { correctIndex: 6 }, { correctIndex: 2 }, { correctIndex: 7 },
        { correctIndex: 5 }, { correctIndex: 0 }, { correctIndex: 3 },
      ];
      computeGroups();
      renderBoard();
    });
    const before = await page.evaluate(() => [
      State.pieces[0].correctIndex, State.pieces[2].correctIndex,
    ]);
    await page.evaluate(() => swapGroup(0, 2));
    const after = await page.evaluate(() => [
      State.pieces[0].correctIndex, State.pieces[2].correctIndex,
    ]);
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);
  });

  test('スワップで手数が増える', async ({ page }) => {
    await startGame(page, 3);
    await page.evaluate(() => swapGroup(0, 1));
    expect(parseInt(await page.locator('#move-count').textContent())).toBeGreaterThan(0);
  });

  test('グループのブロックスワップが正しく機能する', async ({ page }) => {
    await startGame(page, 3);
    // position 0,1 に correctIndex 0,1 を配置 → 水平グループ形成
    await page.evaluate(() => {
      State.pieces[0] = { correctIndex: 0 };
      State.pieces[1] = { correctIndex: 1 };
      State.pieces[2] = { correctIndex: 8 };
      computeGroups();
    });
    const gid = await page.evaluate(() => State.pieces[0].groupId);
    const gid1 = await page.evaluate(() => State.pieces[1].groupId);
    expect(gid).toBe(gid1); // グループ確認

    // グループ[0,1] を position[1,2] に移動（offset +1）
    const before = await page.evaluate(() => ({
      pos0: State.pieces[0].correctIndex,
      pos1: State.pieces[1].correctIndex,
      pos2: State.pieces[2].correctIndex,
    }));
    await page.evaluate(() => swapGroup(0, 1)); // anchor=0 → dst=1, offset=1
    const after = await page.evaluate(() => ({
      pos0: State.pieces[0].correctIndex,
      pos1: State.pieces[1].correctIndex,
      pos2: State.pieces[2].correctIndex,
    }));
    // グループ(0→1, 1→2), displaced(2→0)
    expect(after.pos1).toBe(before.pos0); // グループ先頭が pos1 へ
    expect(after.pos2).toBe(before.pos1); // グループ後尾が pos2 へ
    expect(after.pos0).toBe(before.pos2); // 追い出されたピースが pos0 へ
  });

  test('行またぎになる無効グループ移動は無視される', async ({ page }) => {
    await startGame(page, 3);
    // 3×3グリッド: グループ[1,2] (row0,col1 と row0,col2)
    // swapGroup(1, 2): offset=1 → 新位置[2,3]
    //   p=1: np=2, dstRow=0, expectedRow=0 → OK
    //   p=2: np=3, dstRow=0, expectedRow=0, floor(3/3)=1 ≠ 0 → INVALID (row-wrap)
    await page.evaluate(() => {
      State.pieces[1] = { correctIndex: 0 };
      State.pieces[2] = { correctIndex: 1 };
      computeGroups();
      swapGroup(1, 2); // 行またぎになるため無効のはず
    });
    const moves = parseInt(await page.locator('#move-count').textContent());
    expect(moves).toBe(0); // 無効なので手数は増えない
  });
});

// =========================================================
// 6. パズルクリア
// =========================================================
test.describe('Puzzle Clear', () => {
  test('全ピースを正位置にするとクリアオーバーレイが表示される', async ({ page }) => {
    await startGame(page, 3);
    await page.evaluate(() => {
      const n = State.gridSize;
      State.pieces = Array.from({ length: n*n }, (_, i) => ({ correctIndex: i }));
      State.isSolved = false;
      renderBoard(); checkSolved();
    });
    await expect(page.locator('#overlay-clear')).toBeVisible({ timeout: 7000 });
    await expect(page.locator('.clear-title')).toContainText('CLEAR');
  });

  test('クリア後の手数・タイムが表示される', async ({ page }) => {
    await startGame(page, 3);
    await page.evaluate(() => {
      swapGroup(0, 1); swapGroup(1, 0);
      const n = State.gridSize;
      State.pieces = Array.from({ length: n*n }, (_, i) => ({ correctIndex: i }));
      State.isSolved = false;
      renderBoard(); checkSolved();
    });
    await expect(page.locator('#overlay-clear')).toBeVisible({ timeout: 7000 });
    expect(await page.locator('#clear-moves').textContent()).toBeTruthy();
    expect(await page.locator('#clear-time').textContent()).toMatch(/\d{2}:\d{2}/);
  });

  test('「新しいゲーム」でセットアップ画面に戻る', async ({ page }) => {
    await startGame(page, 3);
    await page.evaluate(() => {
      const n = State.gridSize;
      State.pieces = Array.from({ length: n*n }, (_, i) => ({ correctIndex: i }));
      State.isSolved = false;
      renderBoard(); checkSolved();
    });
    await expect(page.locator('#overlay-clear')).toBeVisible({ timeout: 7000 });
    await page.locator('#btn-new-game').click();
    await expect(page.locator('#screen-setup')).toBeVisible();
  });

  test('「同じ画像でもう一度」でゲームが再スタートする', async ({ page }) => {
    await startGame(page, 3);
    await page.evaluate(() => {
      const n = State.gridSize;
      State.pieces = Array.from({ length: n*n }, (_, i) => ({ correctIndex: i }));
      State.isSolved = false;
      renderBoard(); checkSolved();
    });
    await expect(page.locator('#overlay-clear')).toBeVisible({ timeout: 7000 });
    await page.locator('#btn-retry-same').click();
    await expect(page.locator('#screen-game')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#overlay-clear')).not.toBeVisible();
  });
});

// =========================================================
// 7. ゲームコントロール
// =========================================================
test.describe('Game Controls', () => {
  test('シャッフルで手数リセット', async ({ page }) => {
    await startGame(page, 3);
    await page.evaluate(() => swapGroup(0, 1));
    expect(await page.locator('#move-count').textContent()).toBe('1');
    await page.locator('#btn-shuffle').click();
    expect(await page.locator('#move-count').textContent()).toBe('0');
  });

  test('戻るでセットアップ画面に戻る', async ({ page }) => {
    await startGame(page, 3);
    await page.locator('#btn-back').click();
    await expect(page.locator('#screen-setup')).toBeVisible();
  });
});

// =========================================================
// 8. generateImage で Wikimedia Commons URL が取得される
// =========================================================
test.describe('generateImage', () => {
  test('Wikimedia Commons の画像 URL が取得される', async ({ page }) => {
    await mockImageLoad(page);
    await page.goto(BASE);
    const url = await page.evaluate(() => generateImage('ocean lighthouse'));
    expect(url).toContain('upload.wikimedia.org');
  });

  test('検索結果がない場合はエラーになる', async ({ page }) => {
    // 空の検索結果を返すモック
    await page.route('**commons.wikimedia.org**', route => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ query: { search: [] } }),
      });
    });
    await page.goto(BASE);
    const error = await page.evaluate(async () => {
      try {
        await generateImage('xyznonexistentquery');
        return null;
      } catch (e) {
        return e.message;
      }
    });
    expect(error).toBeTruthy();
    expect(error).toContain('見つかりませんでした');
  });
});

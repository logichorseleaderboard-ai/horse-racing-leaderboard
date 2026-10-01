import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from 'https://esm.sh/@supabase/supabase-js@2/cors'

// ===== 常數設定 =====
const HKJC_API_BASE = 'https://racing.hkjc.com'
const ODDS_API = 'https://bet.hkjc.com/racing/getJSON.aspx'

// 彩池代碼對應
const POOL_WIN = 'WIN'
const POOL_PLA = 'PLA'
const POOL_QIN = 'QIN'
const POOL_QPL = 'QPL'

Deno.serve(async (req) => {
  // 處理 CORS 預檢請求
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. 建立 Admin Client（用 service_role 繞過 RLS）
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 2. 解析請求參數
    const { raceDate } = await req.json()
    if (!raceDate) {
      return new Response(
        JSON.stringify({ error: '缺少 raceDate 參數' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // 3. 讀取該賽日所有投注紀錄
    const { data: bets, error: betsError } = await supabaseAdmin
      .from('bets')
      .select('*')
      .eq('race_date', raceDate)
      .not('flexible_data', 'is', null)

    if (betsError) throw betsError
    if (!bets || bets.length === 0) {
      return new Response(
        JSON.stringify({ message: '該賽日沒有投注紀錄', settledCount: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. 按場次分組
    const raceGroups = new Map<number, typeof bets>()
    bets.forEach(bet => {
      const raceNo = bet.race_no
      if (!raceGroups.has(raceNo)) raceGroups.set(raceNo, [])
      raceGroups.get(raceNo)!.push(bet)
    })

    let settledCount = 0
    const errors: string[] = []

    // 5. 逐場結算
    for (const [raceNo, raceBets] of raceGroups) {
      try {
        // 5.1 從 HKJC 取得該場派彩數據
        const dividends = await fetchDividends(raceDate, raceNo)

        // 5.2 逐條投注計算派彩
        for (const bet of raceBets) {
          const payout = calculatePayout(bet, dividends)

          await supabaseAdmin
            .from('bets')
            .update({ payout: payout })
            .eq('id', bet.id)

          settledCount++
        }
      } catch (err) {
        errors.push(`第 ${raceNo} 場：${(err as Error).message}`)
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        settledCount,
        errors: errors.length > 0 ? errors : undefined,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

// ===================================================================
// 從 HKJC 取得派彩數據
// ===================================================================
async function fetchDividends(raceDate: string, raceNo: number) {
  // 將日期格式化為 YYYY-MM-DD
  const formattedDate = raceDate.replace(/\//g, '-')

  // 方法一：使用 bet.hkjc.com 的 JSON API（較穩定）
  const url = `${ODDS_API}?type=winplace&date=${formattedDate}&raceNo=${raceNo}`

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://bet.hkjc.com/racing/',
      },
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }

    const text = await response.text()
    return parseHkjcResponse(text, raceNo)
  } catch (err) {
    // 方法二：如果 JSON API 失敗，改用網頁爬取
    return await scrapeDividends(formattedDate, raceNo)
  }
}

// ===================================================================
// 解析 HKJC JSON API 回應
// ===================================================================
function parseHkjcResponse(text: string, raceNo: number) {
  const dividends: Record<string, Record<string, number>> = {
    WIN: {},
    PLA: {},
    QIN: {},
    QPL: {},
  }

  try {
    // HKJC 的 JSON API 有時會回傳 JSONP 格式，需要先去掉外層包裝
    let jsonStr = text.trim()
    if (jsonStr.startsWith('(')) {
      jsonStr = jsonStr.slice(1, -1)
    }
    const data = JSON.parse(jsonStr)

    // 解析獨贏 (WIN)
    if (data.win) {
      Object.entries(data.win).forEach(([horseNo, amount]) => {
        dividends.WIN[horseNo] = parseFloat(amount as string)
      })
    }

    // 解析位置 (PLA) — 可能有多匹馬
    if (data.place) {
      Object.entries(data.place).forEach(([horseNo, amount]) => {
        dividends.PLA[horseNo] = parseFloat(amount as string)
      })
    }

    // 解析連贏 (QIN)
    if (data.quinella) {
      Object.entries(data.quinella).forEach(([combo, amount]) => {
        // 組合格式可能是 "8,9" 或 "8-9"，統一轉為 "8,9" 並排序
        const normalized = combo.replace(/-/g, ',').split(',').map(s => s.trim()).sort((a, b) => parseInt(a) - parseInt(b)).join(',')
        dividends.QIN[normalized] = parseFloat(amount as string)
      })
    }

    // 解析位置Q (QPL)
    if (data.quinellaPlace) {
      Object.entries(data.quinellaPlace).forEach(([combo, amount]) => {
        const normalized = combo.replace(/-/g, ',').split(',').map(s => s.trim()).sort((a, b) => parseInt(a) - parseInt(b)).join(',')
        dividends.QPL[normalized] = parseFloat(amount as string)
      })
    }
  } catch (e) {
    console.error('解析 HKJC 回應失敗:', e)
  }

  return dividends
}

// ===================================================================
// 備用方案：直接爬取 HKJC 賽果網頁
// ===================================================================
async function scrapeDividends(raceDate: string, raceNo: number) {
  const url = `${HKJC_API_BASE}/zh-hk/local/information/results?date=${raceDate}&raceNo=${raceNo}`

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  })

  const html = await response.text()
  return parseHkjcHtml(html)
}

// ===================================================================
// 解析 HKJC 賽果網頁 HTML（備用方案）
// ===================================================================
function parseHkjcHtml(html: string) {
  const dividends: Record<string, Record<string, number>> = {
    WIN: {},
    PLA: {},
    QIN: {},
    QPL: {},
  }

  // 注意：HTML 解析在 Deno 環境中較為複雜，這裡用簡單的正則表達式提取
  // 實際使用時建議先用一個真實的 HTML 樣本測試

  // 提取派彩表格中的資料列
  // 格式類似：<tr><td>獨贏</td><td>8</td><td>358.50</td></tr>
  const rowRegex = /<tr[^>]*>[\s\S]*?<td[^>]*>([^<]*)<\/td>[\s\S]*?<td[^>]*>([^<]*)<\/td>[\s\S]*?<td[^>]*>([^<]*)<\/td>[\s\S]*?<\/tr>/g

  let match
  while ((match = rowRegex.exec(html)) !== null) {
    const poolName = match[1].trim()
    const combo = match[2].trim()
    const amountStr = match[3].trim().replace(/,/g, '')
    const amount = parseFloat(amountStr)

    if (isNaN(amount)) continue

    if (poolName.includes('獨贏')) {
      dividends.WIN[combo] = amount
    } else if (poolName.includes('位置') && !poolName.includes('Q')) {
      dividends.PLA[combo] = amount
    } else if (poolName.includes('連贏')) {
      const normalized = combo.split(',').map(s => s.trim()).sort((a, b) => parseInt(a) - parseInt(b)).join(',')
      dividends.QIN[normalized] = amount
    } else if (poolName.includes('位置Q')) {
      const normalized = combo.split(',').map(s => s.trim()).sort((a, b) => parseInt(a) - parseInt(b)).join(',')
      dividends.QPL[normalized] = amount
    }
  }

  return dividends
}

// ===================================================================
// 根據投注紀錄和派彩對照表，計算派彩金額
// ===================================================================
function calculatePayout(bet: any, dividends: Record<string, Record<string, number>>): number {
  let totalPayout = 0
  const fd = bet.flexible_data
  if (!fd || !fd.units) return 0

  const units = fd.units
  const horses: string[] = fd.horses ? fd.horses.split(',').map((s: string) => s.trim()) : []
  const horseCount = horses.length
  const comboType = fd.comboType
  const banker = fd.banker

  // 每注 $10，派彩以每 $10 為單位
  const STAKE_PER_UNIT = 10

  // --- 獨贏 (WIN) ---
  if (units.win > 0) {
    if (horseCount === 1) {
      const key = horses[0]
      if (dividends.WIN[key]) {
        totalPayout += units.win * (dividends.WIN[key] / 10) * STAKE_PER_UNIT
      }
    } else if (comboType === 'banker' && banker) {
      if (dividends.WIN[banker]) {
        totalPayout += units.win * (dividends.WIN[banker] / 10) * STAKE_PER_UNIT
      }
    } else {
      for (const h of horses) {
        if (dividends.WIN[h]) {
          totalPayout += units.win * (dividends.WIN[h] / 10) * STAKE_PER_UNIT
        }
      }
    }
  }

  // --- 位置 (PLA) ---
  if (units.place > 0) {
    if (horseCount === 1) {
      const key = horses[0]
      if (dividends.PLA[key]) {
        totalPayout += units.place * (dividends.PLA[key] / 10) * STAKE_PER_UNIT
      }
    } else if (comboType === 'banker' && banker) {
      if (dividends.PLA[banker]) {
        totalPayout += units.place * (dividends.PLA[banker] / 10) * STAKE_PER_UNIT
      }
    } else {
      for (const h of horses) {
        if (dividends.PLA[h]) {
          totalPayout += units.place * (dividends.PLA[h] / 10) * STAKE_PER_UNIT
        }
      }
    }
  }

  // --- 連贏 (QIN) ---
  if (units.quinella > 0) {
    const combinations = buildCombinations(horses, comboType, banker)
    for (const combo of combinations) {
      if (dividends.QIN[combo]) {
        totalPayout += units.quinella * (dividends.QIN[combo] / 10) * STAKE_PER_UNIT
      }
    }
  }

  // --- 位置Q (QPL) ---
  if (units.quinellaPlace > 0) {
    const combinations = buildCombinations(horses, comboType, banker)
    for (const combo of combinations) {
      if (dividends.QPL[combo]) {
        totalPayout += units.quinellaPlace * (dividends.QPL[combo] / 10) * STAKE_PER_UNIT
      }
    }
  }

  return Math.round(totalPayout * 100) / 100
}

// ===================================================================
// 建立所有投注組合（排序後的 key）
// ===================================================================
function buildCombinations(horses: string[], comboType: string, banker: string | null): string[] {
  const combinations: string[] = []

  if (comboType === 'banker' && banker) {
    // 膽拖：膽馬 + 每匹腳馬
    const legs = horses.filter(h => h !== banker)
    for (const leg of legs) {
      const sorted = [banker, leg].sort((a, b) => parseInt(a) - parseInt(b))
      combinations.push(sorted.join(','))
    }
  } else {
    // 互串：所有兩兩組合
    for (let i = 0; i < horses.length; i++) {
      for (let j = i + 1; j < horses.length; j++) {
        const sorted = [horses[i], horses[j]].sort((a, b) => parseInt(a) - parseInt(b))
        combinations.push(sorted.join(','))
      }
    }
  }

  return combinations
}

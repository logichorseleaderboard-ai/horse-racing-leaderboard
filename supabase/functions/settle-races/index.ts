import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from 'https://esm.sh/@supabase/supabase-js@2/cors'

// ===== 常數 =====
const STAKE_PER_UNIT = 10

Deno.serve(async (req) => {
  // 處理 CORS 預檢請求
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // ===== 正式結算邏輯 =====
  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    const { raceDate, racecourse } = await req.json()
    if (!raceDate) {
      return new Response(
        JSON.stringify({ error: '缺少 raceDate 參數' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    // 1. 讀取未結算的投注
    const { data: bets, error: betsError } = await supabaseAdmin
      .from('bets')
      .select('*')
      .eq('race_date', raceDate)
      .not('flexible_data', 'is', null)
      .or('settled.is.null,settled.eq.false')

    if (betsError) throw betsError
    if (!bets || bets.length === 0) {
      return new Response(
        JSON.stringify({ message: '沒有未結算的投注紀錄', settledCount: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 2. 按場次分組
    const raceGroups = new Map<number, typeof bets>()
    bets.forEach(bet => {
      const raceNo = bet.race_no
      if (!raceGroups.has(raceNo)) raceGroups.set(raceNo, [])
      raceGroups.get(raceNo)!.push(bet)
    })

    let settledCount = 0
    const errors: string[] = []

    // 3. 逐場結算
    for (const [raceNo, raceBets] of raceGroups) {
      try {
        const html = await fetchRaceResultPage(raceDate, raceNo, racecourse)
        const dividends = parseDividendsFromHtml(html)
        console.log(`第 ${raceNo} 場派彩解析結果:`, JSON.stringify(dividends))

        // ===== 寫入派彩數據到 race_dividends table =====
        const dividendRows: any[] = []
        for (const [poolType, combos] of Object.entries(dividends)) {
          for (const [combo, amount] of Object.entries(combos)) {
            dividendRows.push({
              race_date: raceDate,
              race_no: raceNo,
              pool_type: poolType,
              winning_combination: combo,
              dividend: amount,
            })
          }
        }

        if (dividendRows.length > 0) {
          // 先刪除該場舊紀錄，避免重複
          await supabaseAdmin
            .from('race_dividends')
            .delete()
            .eq('race_date', raceDate)
            .eq('race_no', raceNo)

          const { error: divError } = await supabaseAdmin
            .from('race_dividends')
            .insert(dividendRows)

          if (divError) {
            console.error(`第 ${raceNo} 場寫入派彩數據失敗:`, divError)
          } else {
            console.log(`第 ${raceNo} 場已寫入 ${dividendRows.length} 條派彩紀錄`)
          }
        }
        // ===== 派彩數據寫入結束 =====

        // 4. 逐條投注計算派彩
        for (const bet of raceBets) {
          const payout = calculatePayout(bet, dividends)
          await supabaseAdmin
            .from('bets')
            .update({
              payout: payout,
              settled: true,
              settlement_source: 'auto',
            })
            .eq('id', bet.id)
          settledCount++
        }
      } catch (err) {
        errors.push(`第 ${raceNo} 場：${(err as Error).message}`)
        console.error(`第 ${raceNo} 場結算失敗:`, err)
      }
    }

    return new Response(
      JSON.stringify({ success: true, settledCount, errors: errors.length > 0 ? errors : undefined }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('結算失敗:', error)
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})

// ===================================================================
// 抓取 HKJC 賽果頁面
// ===================================================================
async function fetchRaceResultPage(raceDate: string, raceNo: number, racecourse?: string): Promise<string> {
  const formattedDate = raceDate.replace(/-/g, '/')
  const courses = racecourse ? [racecourse] : ['ST', 'HV']

  for (const course of courses) {
    const url = `https://racing.hkjc.com/zh-hk/local/information/localresults?racedate=${formattedDate}&Racecourse=${course}&RaceNo=${raceNo}`
    console.log(`[fetchRaceResultPage] 嘗試: ${url}`)

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-HK,zh;q=0.9',
      },
    })

    if (!response.ok) {
      console.log(`[fetchRaceResultPage] HTTP ${response.status}`)
      continue
    }

    const html = await response.text()

    if (html.includes('派彩') && (html.includes('獨贏') || html.includes('位置'))) {
      console.log(`[fetchRaceResultPage] 找到派彩數據，HTML 長度: ${html.length}`)
      return html
    }
    console.log(`[fetchRaceResultPage] 此頁面無派彩數據`)
  }

  throw new Error(`找不到 ${raceDate} 第 ${raceNo} 場的賽果頁面`)
}

// ===================================================================
// 從 HTML 解析派彩數據（支援 rowspan 跨行）
// ===================================================================
function parseDividendsFromHtml(html: string): Record<string, Record<string, number>> {
  const dividends: Record<string, Record<string, number>> = {
    WIN: {}, PLA: {}, QIN: {}, QPL: {},
  }

  const dividendSectionMatch = html.match(/派彩[\s\S]*?(?=<div|<\/body>|$)/i)
  const targetHtml = dividendSectionMatch ? dividendSectionMatch[0] : html

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
  let rowMatch
  let lastPoolName = ''

  while ((rowMatch = rowRegex.exec(targetHtml)) !== null) {
    const rowHtml = rowMatch[1]

    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
    const tds: string[] = []
    let tdMatch
    while ((tdMatch = tdRegex.exec(rowHtml)) !== null) {
      tds.push(tdMatch[1].replace(/<[^>]*>/g, '').trim())
    }

    if (tds.length < 2) continue

    let poolName = ''
    let combo = ''
    let amountStr = ''

    if (tds.length >= 3) {
      poolName = tds[0]
      combo = tds[1]
      amountStr = tds[2]
      lastPoolName = poolName
    } else if (tds.length === 2) {
      poolName = lastPoolName
      combo = tds[0]
      amountStr = tds[1]
    }

    const amount = parseFloat(amountStr.replace(/,/g, ''))
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
// 計算派彩
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
// 建立投注組合
// ===================================================================
function buildCombinations(horses: string[], comboType: string, banker: string | null): string[] {
  const combinations: string[] = []

  if (comboType === 'banker' && banker) {
    const legs = horses.filter(h => h !== banker)
    for (const leg of legs) {
      const sorted = [banker, leg].sort((a, b) => parseInt(a) - parseInt(b))
      combinations.push(sorted.join(','))
    }
  } else {
    for (let i = 0; i < horses.length; i++) {
      for (let j = i + 1; j < horses.length; j++) {
        const sorted = [horses[i], horses[j]].sort((a, b) => parseInt(a) - parseInt(b))
        combinations.push(sorted.join(','))
      }
    }
  }

  return combinations
}

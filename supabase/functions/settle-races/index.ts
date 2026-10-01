import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders } from 'https://esm.sh/@supabase/supabase-js@2/cors'
import { HorseRacingAPI } from 'npm:hkjc-api'

// ===== 常數 =====
const STAKE_PER_UNIT = 10

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

    // 3. 讀取該賽日未結算的投注紀錄
    const { data: bets, error: betsError } = await supabaseAdmin
      .from('bets')
      .select('*')
      .eq('race_date', raceDate)
      .not('flexible_data', 'is', null)
      .or('settled.is.null,settled.eq.false')

    if (betsError) throw betsError
    if (!bets || bets.length === 0) {
      return new Response(
        JSON.stringify({ message: '該賽日沒有未結算的投注紀錄', settledCount: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 4. 初始化 hkjc-api
    const horseAPI = new HorseRacingAPI()

    // 5. 按場次分組
    const raceGroups = new Map<number, typeof bets>()
    bets.forEach(bet => {
      const raceNo = bet.race_no
      if (!raceGroups.has(raceNo)) raceGroups.set(raceNo, [])
      raceGroups.get(raceNo)!.push(bet)
    })

    let settledCount = 0
    const errors: string[] = []

    // 6. 逐場結算
    for (const [raceNo, raceBets] of raceGroups) {
      try {
        // 6.1 用 hkjc-api 拎取派彩數據
        const result = await horseAPI.getRaceOdds(raceNo, ['WIN', 'PLA', 'QIN', 'QPL'])
        console.log(`第 ${raceNo} 場 hkjc-api 返回:`, JSON.stringify(result).substring(0, 800))

        // 6.2 解析派彩數據
        const dividends = parseHkjcApiResult(result)
        console.log(`第 ${raceNo} 場解析結果:`, JSON.stringify(dividends))

        // 6.3 逐條投注計算派彩
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
      JSON.stringify({
        success: true,
        settledCount,
        errors: errors.length > 0 ? errors : undefined,
      }),
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
// 解析 hkjc-api 返回的派彩數據
// ===================================================================
function parseHkjcApiResult(result: any): Record<string, Record<string, number>> {
  const dividends: Record<string, Record<string, number>> = {
    WIN: {},
    PLA: {},
    QIN: {},
    QPL: {},
  }

  try {
    // ⚠️ 以下解析邏輯需要根據 hkjc-api 實際返回的 JSON 結構調整
    // 請先睇 Supabase Logs 入面 "hkjc-api 返回" 的實際格式，再對應修改

    // 常見格式一：result 直接包含各彩池
    if (result?.win) {
      Object.entries(result.win).forEach(([horseNo, amount]) => {
        dividends.WIN[horseNo] = parseFloat(amount as string)
      })
    }
    if (result?.place) {
      Object.entries(result.place).forEach(([horseNo, amount]) => {
        dividends.PLA[horseNo] = parseFloat(amount as string)
      })
    }
    if (result?.quinella) {
      Object.entries(result.quinella).forEach(([combo, amount]) => {
        const normalized = combo.replace(/-/g, ',').split(',').map(s => s.trim()).sort((a, b) => parseInt(a) - parseInt(b)).join(',')
        dividends.QIN[normalized] = parseFloat(amount as string)
      })
    }
    if (result?.quinellaPlace) {
      Object.entries(result.quinellaPlace).forEach(([combo, amount]) => {
        const normalized = combo.replace(/-/g, ',').split(',').map(s => s.trim()).sort((a, b) => parseInt(a) - parseInt(b)).join(',')
        dividends.QPL[normalized] = parseFloat(amount as string)
      })
    }

    // 常見格式二：result 包含 dividends 陣列
    if (result?.dividends && Array.isArray(result.dividends)) {
      for (const d of result.dividends) {
        const pool = d.poolType || d.pool
        const combo = d.winningCombination || d.combination
        const amount = parseFloat(d.dividend || d.amount)

        if (pool === 'WIN') {
          dividends.WIN[combo] = amount
        } else if (pool === 'PLA') {
          dividends.PLA[combo] = amount
        } else if (pool === 'QIN') {
          const normalized = combo.replace(/-/g, ',').split(',').map((s: string) => s.trim()).sort((a: string, b: string) => parseInt(a) - parseInt(b)).join(',')
          dividends.QIN[normalized] = amount
        } else if (pool === 'QPL') {
          const normalized = combo.replace(/-/g, ',').split(',').map((s: string) => s.trim()).sort((a: string, b: string) => parseInt(a) - parseInt(b)).join(',')
          dividends.QPL[normalized] = amount
        }
      }
    }
  } catch (e) {
    console.error('解析 hkjc-api 返回失敗:', e)
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

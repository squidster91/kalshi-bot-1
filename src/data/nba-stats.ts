import { logger } from '../logger';

const NBA_STATS_BASE = 'https://stats.nba.com/stats';

const NBA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.nba.com/',
  'Origin': 'https://www.nba.com',
};

interface NBAGameLog {
  gameId: string;
  gameDate: string;
  teamId: number;
  teamAbbr: string;
  matchup: string;
  wl: string;
  pts: number;
  opp_pts: number;
  total_pts: number;
  margin: number;
}

interface NBAPlayerGameLog {
  gameId: string;
  gameDate: string;
  playerId: number;
  playerName: string;
  teamAbbr: string;
  pts: number;
  reb: number;
  ast: number;
  fg3m: number;
  min: number;
  wl: string;
}

/**
 * Fetch team game logs for a given season.
 */
export async function fetchTeamGameLogs(
  season: string = '2025-26'
): Promise<NBAGameLog[]> {
  const url = `${NBA_STATS_BASE}/leaguegamelog?Season=${season}&SeasonType=Regular+Season&PlayerOrTeam=T&Direction=ASC&Sorter=DATE`;

  try {
    const response = await fetch(url, { headers: NBA_HEADERS });
    if (!response.ok) {
      throw new Error(`NBA API error: ${response.status}`);
    }

    const data = await response.json() as {
      resultSets: Array<{
        headers: string[];
        rowSet: unknown[][];
      }>;
    };

    const resultSet = data.resultSets[0];
    const headers = resultSet.headers;
    const rows = resultSet.rowSet;

    const gameIdIdx = headers.indexOf('GAME_ID');
    const gameDateIdx = headers.indexOf('GAME_DATE');
    const teamIdIdx = headers.indexOf('TEAM_ID');
    const teamAbbrIdx = headers.indexOf('TEAM_ABBREVIATION');
    const matchupIdx = headers.indexOf('MATCHUP');
    const wlIdx = headers.indexOf('WL');
    const ptsIdx = headers.indexOf('PTS');

    return rows.map((row) => {
      const pts = row[ptsIdx] as number;
      return {
        gameId: row[gameIdIdx] as string,
        gameDate: row[gameDateIdx] as string,
        teamId: row[teamIdIdx] as number,
        teamAbbr: row[teamAbbrIdx] as string,
        matchup: row[matchupIdx] as string,
        wl: row[wlIdx] as string,
        pts,
        opp_pts: 0, // Will be computed from paired records
        total_pts: 0,
        margin: 0,
      };
    });
  } catch (err) {
    logger.error('Failed to fetch team game logs', { error: String(err) });
    return [];
  }
}

/**
 * Fetch player game logs for a given season.
 */
export async function fetchPlayerGameLogs(
  season: string = '2025-26'
): Promise<NBAPlayerGameLog[]> {
  const url = `${NBA_STATS_BASE}/leaguegamelog?Season=${season}&SeasonType=Regular+Season&PlayerOrTeam=P&Direction=ASC&Sorter=DATE`;

  try {
    const response = await fetch(url, { headers: NBA_HEADERS });
    if (!response.ok) {
      throw new Error(`NBA API error: ${response.status}`);
    }

    const data = await response.json() as {
      resultSets: Array<{
        headers: string[];
        rowSet: unknown[][];
      }>;
    };

    const resultSet = data.resultSets[0];
    const headers = resultSet.headers;
    const rows = resultSet.rowSet;

    const getIdx = (name: string) => headers.indexOf(name);

    return rows.map((row) => ({
      gameId: row[getIdx('GAME_ID')] as string,
      gameDate: row[getIdx('GAME_DATE')] as string,
      playerId: row[getIdx('PLAYER_ID')] as number,
      playerName: row[getIdx('PLAYER_NAME')] as string,
      teamAbbr: row[getIdx('TEAM_ABBREVIATION')] as string,
      pts: row[getIdx('PTS')] as number,
      reb: row[getIdx('REB')] as number,
      ast: row[getIdx('AST')] as number,
      fg3m: row[getIdx('FG3M')] as number,
      min: parseFloat(row[getIdx('MIN')] as string) || 0,
      wl: row[getIdx('WL')] as string,
    }));
  } catch (err) {
    logger.error('Failed to fetch player game logs', { error: String(err) });
    return [];
  }
}

/**
 * Pair team game logs to compute opponent points and totals.
 */
export function pairTeamGames(logs: NBAGameLog[]): NBAGameLog[] {
  // Group by game ID
  const byGame = new Map<string, NBAGameLog[]>();
  for (const log of logs) {
    const existing = byGame.get(log.gameId) ?? [];
    existing.push(log);
    byGame.set(log.gameId, existing);
  }

  const paired: NBAGameLog[] = [];
  for (const [, gameLogs] of byGame) {
    if (gameLogs.length !== 2) continue;

    const [a, b] = gameLogs;
    a.opp_pts = b.pts;
    a.total_pts = a.pts + b.pts;
    a.margin = a.pts - b.pts;

    b.opp_pts = a.pts;
    b.total_pts = a.pts + b.pts;
    b.margin = b.pts - a.pts;

    paired.push(a, b);
  }

  return paired;
}

/**
 * Compute pairwise correlations between market outcomes.
 */
export function computeCorrelations(
  teamGames: NBAGameLog[],
  playerGames: NBAPlayerGameLog[]
): Record<string, { correlation: number; sampleSize: number }> {
  const results: Record<string, { correlation: number; sampleSize: number }> = {};

  // Group player games by game ID
  const playersByGame = new Map<string, NBAPlayerGameLog[]>();
  for (const pg of playerGames) {
    const existing = playersByGame.get(pg.gameId) ?? [];
    existing.push(pg);
    playersByGame.set(pg.gameId, existing);
  }

  // Pair team data
  const paired = pairTeamGames(teamGames);
  const winnerGames = paired.filter((g) => g.wl === 'W');

  // moneyline vs total
  const mlTotalPairs = winnerGames.map((g) => ({
    ml: 1, // winner
    total: g.total_pts,
  }));
  if (mlTotalPairs.length > 30) {
    const meanTotal = mlTotalPairs.reduce((s, p) => s + p.total, 0) / mlTotalPairs.length;
    // Biserial correlation between winning and high total
    const winHighTotal = mlTotalPairs.filter((p) => p.total > meanTotal).length;
    results['moneyline:total'] = {
      correlation: (winHighTotal / mlTotalPairs.length - 0.5) * 2,
      sampleSize: mlTotalPairs.length,
    };
  }

  // player_pts vs player_ast (same player, same game)
  const ptsAstPairs: Array<{ pts: number; ast: number }> = [];
  for (const [, players] of playersByGame) {
    for (const p of players) {
      if (p.min >= 15) {
        ptsAstPairs.push({ pts: p.pts, ast: p.ast });
      }
    }
  }
  if (ptsAstPairs.length > 50) {
    results['player_pts:player_ast'] = {
      correlation: pearsonCorrelation(
        ptsAstPairs.map((p) => p.pts),
        ptsAstPairs.map((p) => p.ast)
      ),
      sampleSize: ptsAstPairs.length,
    };
  }

  // player_pts vs player_reb
  const ptsRebPairs = ptsAstPairs.length > 0
    ? playerGames.filter((p) => p.min >= 15).map((p) => ({ pts: p.pts, reb: p.reb }))
    : [];
  if (ptsRebPairs.length > 50) {
    results['player_pts:player_reb'] = {
      correlation: pearsonCorrelation(
        ptsRebPairs.map((p) => p.pts),
        ptsRebPairs.map((p) => p.reb)
      ),
      sampleSize: ptsRebPairs.length,
    };
  }

  // total vs player_pts (game total vs individual scoring)
  const totalPtsPairs: Array<{ total: number; pts: number }> = [];
  for (const tg of paired) {
    const players = playersByGame.get(tg.gameId) ?? [];
    for (const p of players) {
      if (p.min >= 15 && p.teamAbbr === tg.teamAbbr) {
        totalPtsPairs.push({ total: tg.total_pts, pts: p.pts });
      }
    }
  }
  if (totalPtsPairs.length > 50) {
    results['total:player_pts'] = {
      correlation: pearsonCorrelation(
        totalPtsPairs.map((p) => p.total),
        totalPtsPairs.map((p) => p.pts)
      ),
      sampleSize: totalPtsPairs.length,
    };
  }

  return results;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  if (denom === 0) return 0;
  return cov / denom;
}

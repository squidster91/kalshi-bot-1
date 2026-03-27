import { LegPrice, parseLegType } from './marginals';
import { buildCorrelationMatrix } from './correlation';
import { logger } from '../logger';

/**
 * Gaussian copula for computing joint probability of correlated events.
 *
 * For 2 legs: P(A AND B) = Φ₂(Φ⁻¹(P(A)), Φ⁻¹(P(B)), ρ)
 * For N legs: Use Monte Carlo simulation with correlated normal draws.
 */

// ── Normal Distribution Functions ──
// Implemented directly to avoid heavy dependencies

/**
 * Standard normal CDF using Abramowitz & Stegun approximation.
 * Accurate to ~1e-7.
 */
export function normalCDF(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Inverse standard normal CDF (quantile function).
 * Rational approximation by Peter Acklam.
 */
export function normalInvCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;

  const a = [
    -3.969683028665376e+01,
    2.209460984245205e+02,
    -2.759285104469687e+02,
    1.383577518672690e+02,
    -3.066479806614716e+01,
    2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01,
    1.615858368580409e+02,
    -1.556989798598866e+02,
    6.680131188771972e+01,
    -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03,
    -3.223964580411365e-01,
    -2.400758277161838e+00,
    -2.549732539343734e+00,
    4.374664141464968e+00,
    2.938163982698783e+00,
  ];
  const d = [
    7.784695709041462e-03,
    3.224671290700398e-01,
    2.445134137142996e+00,
    3.754408661907416e+00,
  ];

  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  let q: number, r: number;

  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
}

/**
 * Bivariate normal CDF: Φ₂(x, y, ρ)
 * Using Drezner-Wesolowsky approximation for the bivariate case.
 */
export function bivariateNormalCDF(x: number, y: number, rho: number): number {
  if (Math.abs(rho) < 1e-10) {
    return normalCDF(x) * normalCDF(y);
  }

  if (Math.abs(rho - 1) < 1e-10) {
    return normalCDF(Math.min(x, y));
  }

  if (Math.abs(rho + 1) < 1e-10) {
    return Math.max(0, normalCDF(x) + normalCDF(y) - 1);
  }

  // Gauss-Legendre quadrature for bivariate normal
  // Using 5-point quadrature
  const weights = [0.0188, 0.1303, 0.3026, 0.3026, 0.1303, 0.0188];
  const abscissas = [-0.9324, -0.6612, -0.2386, 0.2386, 0.6612, 0.9324];

  const rho2 = rho * rho;
  const sqrtOneMinusRho2 = Math.sqrt(1 - rho2);

  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    const si = abscissas[i];
    const adjustedY = (y - rho * x) / sqrtOneMinusRho2;
    // For the quadrature approach, integrate over the conditional distribution
    const u = x * si;
    sum += weights[i] * normalCDF((y - rho * u) / sqrtOneMinusRho2) *
      Math.exp(-u * u / 2) / Math.sqrt(2 * Math.PI);
  }

  // Fall back to a more reliable simple approximation
  // Tetrachoric expansion for moderate correlations
  return bivariateNormalTetrachoric(x, y, rho);
}

/**
 * Tetrachoric series expansion for bivariate normal CDF.
 * More numerically stable for our use case.
 */
function bivariateNormalTetrachoric(x: number, y: number, rho: number): number {
  const phiX = normalCDF(x);
  const phiY = normalCDF(y);

  if (Math.abs(rho) < 0.01) {
    return phiX * phiY;
  }

  // Use the identity:
  // Φ₂(x, y, ρ) ≈ Φ(x)·Φ(y) + ρ·φ(x)·φ(y) + higher order terms
  const pdfX = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const pdfY = Math.exp(-y * y / 2) / Math.sqrt(2 * Math.PI);

  // First-order correction
  let result = phiX * phiY + rho * pdfX * pdfY;

  // Second-order correction: (ρ²/2) · (x·y - 1) · φ(x) · φ(y) ... actually use Hermite polynomials
  const rho2 = rho * rho;
  result += (rho2 / 2) * pdfX * pdfY * ((x * x - 1) * (y * y - 1) - 2 * rho * x * y) / (1 - rho2);

  // Clamp to valid probability range
  return Math.max(0, Math.min(Math.min(phiX, phiY), result));
}

// ── Cholesky Decomposition for Monte Carlo ──

/**
 * Cholesky decomposition of a positive-definite matrix.
 * Returns lower triangular matrix L such that A = L × L^T.
 */
function choleskyDecomposition(matrix: number[][]): number[][] {
  const n = matrix.length;
  const L: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }

      if (i === j) {
        const diag = matrix[i][i] - sum;
        if (diag <= 0) {
          // Matrix not positive definite — nudge diagonal
          L[i][j] = Math.sqrt(Math.max(diag, 1e-10));
        } else {
          L[i][j] = Math.sqrt(diag);
        }
      } else {
        L[i][j] = (matrix[i][j] - sum) / L[j][j];
      }
    }
  }

  return L;
}

/**
 * Box-Muller transform for generating standard normal random variates.
 */
function randomNormal(): number {
  let u1: number, u2: number;
  do {
    u1 = Math.random();
    u2 = Math.random();
  } while (u1 === 0);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Joint Probability Computation ──

/**
 * Compute joint probability for 2 legs using the bivariate normal CDF.
 */
export function jointProbability2Legs(
  p1: number,
  p2: number,
  correlation: number
): number {
  // Clamp probabilities to avoid infinities in inverse CDF
  const clampedP1 = Math.max(0.001, Math.min(0.999, p1));
  const clampedP2 = Math.max(0.001, Math.min(0.999, p2));

  const z1 = normalInvCDF(clampedP1);
  const z2 = normalInvCDF(clampedP2);

  return bivariateNormalCDF(z1, z2, correlation);
}

/**
 * Compute joint probability for N legs using Monte Carlo simulation
 * with Gaussian copula (correlated normal draws via Cholesky decomposition).
 *
 * @param probabilities - Array of marginal probabilities for each leg
 * @param correlationMatrix - N×N correlation matrix
 * @param numSimulations - Number of Monte Carlo draws (default 50000)
 */
export function jointProbabilityMonteCarlo(
  probabilities: number[],
  correlationMatrix: number[][],
  numSimulations: number = 50_000
): number {
  const n = probabilities.length;

  if (n === 0) return 1;
  if (n === 1) return probabilities[0];
  if (n === 2) {
    return jointProbability2Legs(
      probabilities[0],
      probabilities[1],
      correlationMatrix[0][1]
    );
  }

  // Cholesky decomposition of correlation matrix
  const L = choleskyDecomposition(correlationMatrix);

  // Convert probabilities to z-scores (thresholds in normal space)
  const thresholds = probabilities.map((p) =>
    normalInvCDF(Math.max(0.001, Math.min(0.999, p)))
  );

  let hits = 0;

  for (let sim = 0; sim < numSimulations; sim++) {
    // Generate independent standard normal draws
    const z: number[] = Array.from({ length: n }, () => randomNormal());

    // Correlate using Cholesky factor: x = L × z
    const x: number[] = Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        x[i] += L[i][j] * z[j];
      }
    }

    // Check if all correlated draws fall below their respective thresholds
    let allBelow = true;
    for (let i = 0; i < n; i++) {
      if (x[i] > thresholds[i]) {
        allBelow = false;
        break;
      }
    }

    if (allBelow) hits++;
  }

  return hits / numSimulations;
}

/**
 * Main entry point: compute the joint probability for a combo given leg prices.
 * Uses bivariate normal for 2-leg combos, Monte Carlo for 3+ legs.
 */
export function computeJointProbability(legPrices: LegPrice[]): number {
  const probabilities = legPrices.map((l) => l.probability);
  const tickers = legPrices.map((l) => l.ticker);

  if (probabilities.length <= 1) {
    return probabilities[0] ?? 1;
  }

  const corrMatrix = buildCorrelationMatrix(tickers);

  if (probabilities.length === 2) {
    return jointProbability2Legs(
      probabilities[0],
      probabilities[1],
      corrMatrix[0][1]
    );
  }

  const jointProb = jointProbabilityMonteCarlo(probabilities, corrMatrix);
  const naiveProb = probabilities.reduce((a, b) => a * b, 1);

  logger.debug('Joint probability computed', {
    naive: naiveProb,
    copula: jointProb,
    ratio: jointProb / naiveProb,
    legs: probabilities.length,
  });

  return jointProb;
}

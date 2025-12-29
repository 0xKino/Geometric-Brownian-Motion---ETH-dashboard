import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  CartesianGrid,
  ComposedChart,
  Line,
  Brush,
  ReferenceDot
} from 'recharts';
import {
  Calculator,
  TrendingDown,
  TrendingUp,
  Clock,
  Activity,
  AlertTriangle,
  Wifi,
  WifiOff,
  Target,
  ArrowRight,
  Settings,
  BookOpen,
  Sigma,
  MousePointer2,
  Eye
} from 'lucide-react';

// --- MATH UTILITIES ---

/**
 * Standard Normal Cumulative Distribution Function (CDF)
 */
function cumulativeDistribution(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.39894228040 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  if (x > 0) return 1 - p;
  return p;
}

const formatCurrency = (val: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(val);

const formatNumber = (val: number, d = 4) => val.toFixed(d);

// --- TYPES ---

type TrendBias = 'bear' | 'neutral' | 'bull';

interface HistoryPoint {
  timestamp: number;
  price: number;
}

interface ChartPoint {
  timestamp: number;
  price?: number;
  mean?: number;
  // Ranges for cones: [Lower, Upper]
  sigma1?: [number, number]; 
  sigma2?: [number, number];
  sigma3?: [number, number];
}

// --- COMPONENTS ---

// A small helper to render mathematical steps cleanly
const MathStep = ({ label, formula, result, desc }: { label: string, formula: string, result: string, desc?: string }) => (
  <div className="border-l-2 border-slate-700 pl-4 py-1 mb-4">
    <div className="flex justify-between items-baseline mb-1">
      <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider">{label}</span>
      <span className="font-mono text-emerald-400 font-bold">{result}</span>
    </div>
    <div className="font-mono text-slate-300 text-sm mb-1">{formula}</div>
    {desc && <div className="text-xs text-slate-500 italic">{desc}</div>}
  </div>
);

// Custom Dot for the "Snake Head"
const PulsingDot = (props: any) => {
  const { cx, cy, stroke, payload, index, dataLength } = props;
  // Only render on the last point of history
  if (index !== dataLength - 1) return null;

  return (
    <svg x={cx - 10} y={cy - 10} width={20} height={20} viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="4" fill={stroke} className="animate-pulse" opacity="0.5">
         <animate attributeName="r" values="4;8;4" dur="2s" repeatCount="indefinite" />
         <animate attributeName="opacity" values="0.5;0;0.5" dur="2s" repeatCount="indefinite" />
      </circle>
      <circle cx="10" cy="10" r="3" fill="white" stroke={stroke} strokeWidth="2" />
    </svg>
  );
};

// --- MAIN APPLICATION ---

const EtherQuantDashboard: React.FC = () => {
  // --- STATE ---
  
  // Market Data
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [liveVol, setLiveVol] = useState<number>(60);
  const [isVolEstimated, setIsVolEstimated] = useState<boolean>(false);
  const [isConnected, setIsConnected] = useState<boolean>(false);

  // User Controls
  const [targetPrice, setTargetPrice] = useState<number>(3000.00);
  const [timeMinutes, setTimeMinutes] = useState<number>(10);
  const [bias, setBias] = useState<TrendBias>('neutral');
  
  // Volatility Controls
  const [useLiveVol, setUseLiveVol] = useState<boolean>(true);
  const [manualVol, setManualVol] = useState<number>(60);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);

  // Derived
  const activeVolatility = useLiveVol ? liveVol : manualVol;

  // --- 1. LIVE MARKET DATA ---

  // WebSocket for Price
  useEffect(() => {
    const connect = () => {
      const ws = new WebSocket('wss://stream.binance.com:9443/ws/ethusdt@trade');
      wsRef.current = ws;

      ws.onopen = () => setIsConnected(true);
      ws.onclose = () => setIsConnected(false);
      
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const currentPrice = parseFloat(data.p);
        const now = Date.now();

        setLivePrice(currentPrice);
        setHistory(prev => {
          // Keep more history for scrolling (150 ticks)
          const newHistory = [...prev, { timestamp: now, price: currentPrice }];
          return newHistory.slice(-150);
        });
      };
    };

    connect();
    return () => wsRef.current?.close();
  }, []);

  // Fetch DVOL
  useEffect(() => {
    const fetchDvol = async () => {
      try {
        const response = await fetch('https://www.deribit.com/api/v2/public/get_dvol_index?index_name=eth_dvol');
        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();
        const dvol = data.result.index_price;
        if (dvol) {
          setLiveVol(dvol);
          setIsVolEstimated(false);
        }
      } catch (error) {
        setLiveVol(60); 
        setIsVolEstimated(true);
      }
    };
    fetchDvol();
    const interval = setInterval(fetchDvol, 60000);
    return () => clearInterval(interval);
  }, []);

  // Set initial target
  useEffect(() => {
    if (livePrice && targetPrice === 3000 && livePrice !== 3000) {
       setTargetPrice(Math.round(livePrice * 0.998)); // Default slightly below for interesting prob
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrice]);

  // --- 2. PROBABILISTIC MODELING ---

  const model = useMemo(() => {
    if (!livePrice) return null;

    // 1. Inputs
    const S = livePrice;
    const K = targetPrice;
    const t_years = timeMinutes / 525600; // 525600 minutes in a year
    const sigma = activeVolatility / 100;

    // 2. Drift (μ)
    let mu = 0;
    if (bias === 'bull') mu = 0.5 * sigma;
    if (bias === 'bear') mu = -0.5 * sigma;

    // 3. Log Return
    const logReturn = Math.log(K / S);

    // 4. Ito's Correction & Drift Term
    // Geometric Brownian Motion log-returns are normally distributed with mean (μ - σ²/2)t
    const driftCorrection = mu - 0.5 * Math.pow(sigma, 2);
    const driftTerm = driftCorrection * t_years;

    // 5. Diffusion Term (Denominator)
    const diffusionTerm = sigma * Math.sqrt(t_years);

    // 6. Z-Score
    // Standardizing the random variable
    const numerator = logReturn - driftTerm;
    const zScore = numerator / diffusionTerm;

    // 7. Probability
    // The CDF gives P(Z < zScore).
    // If K > S (Target is above), we usually want probability of hitting it (going UP).
    // If K < S (Target is below), we want probability of dropping to it (going DOWN).
    // The Z-Score formula z = (ln(K/S) - ...)/... measures how many SDs K is from the Mean.
    // If z is positive, K is above the mean. If z is negative, K is below.
    
    // CDF(z) is the probability that the realized price will be LESS THAN K.
    const cdf = cumulativeDistribution(zScore);
    
    // If target is ABOVE price, we want P(St > K) = 1 - CDF(z)
    // If target is BELOW price, we want P(St < K) = CDF(z)
    const probability = targetPrice > livePrice ? (1 - cdf) : cdf;
    const direction = targetPrice > livePrice ? 'above' : 'below';

    return { 
      S, K, t_years, sigma, mu, 
      driftCorrection, driftTerm, diffusionTerm, 
      logReturn, zScore, probability, direction 
    };
  }, [livePrice, targetPrice, timeMinutes, activeVolatility, bias]);

  // --- 3. CHART DATA ---

  const chartData = useMemo(() => {
    if (!livePrice || !model) return [];

    // Historical
    const historyData: ChartPoint[] = history.map(h => ({
      timestamp: h.timestamp,
      price: h.price,
      mean: undefined,
      sigma1: undefined,
      sigma2: undefined,
      sigma3: undefined,
    }));

    // Projection
    const projectionData: ChartPoint[] = [];
    const steps = 40;
    const now = Date.now();
    const timeStepMinutes = timeMinutes / steps;

    for (let i = 0; i <= steps; i++) {
      const stepTimeMinutes = i * timeStepMinutes;
      const stepT = stepTimeMinutes / 525600;
      const futureTimestamp = now + (stepTimeMinutes * 60 * 1000);

      // Bridge point
      if (i === 0) {
        projectionData.push({
          timestamp: futureTimestamp,
          price: undefined,
          mean: livePrice,
          sigma1: [livePrice, livePrice],
          sigma2: [livePrice, livePrice],
          sigma3: [livePrice, livePrice],
        });
        continue;
      }

      // Paths
      const totalDrift = model.driftCorrection * stepT;
      const totalDiffusion = model.sigma * Math.sqrt(stepT);

      const meanPrice = livePrice * Math.exp(totalDrift);

      // Calculate 3 Sigma Cones
      const calcBounds = (n: number): [number, number] => {
        const upper = livePrice * Math.exp(totalDrift + n * totalDiffusion);
        const lower = livePrice * Math.exp(totalDrift - n * totalDiffusion);
        return [lower, upper];
      };

      projectionData.push({
        timestamp: futureTimestamp,
        price: undefined,
        mean: meanPrice,
        sigma1: calcBounds(1), // 68%
        sigma2: calcBounds(2), // 95%
        sigma3: calcBounds(3), // 99.7%
      });
    }

    return [...historyData, ...projectionData];
  }, [livePrice, history, timeMinutes, model]);


  // --- RENDER ---

  if (!livePrice) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center text-slate-400 gap-4">
        <Activity className="animate-pulse w-12 h-12 text-indigo-500" />
        <div className="text-lg font-mono">Initializing Feed...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 font-sans p-4 md:p-8 overflow-hidden relative selection:bg-indigo-500/30">
      
      {/* HEADER */}
      <div className="max-w-7xl mx-auto mb-6 flex flex-col md:flex-row justify-between items-start md:items-end gap-6 relative z-10 border-b border-slate-800/50 pb-6">
        <div>
          <h1 className="text-3xl md:text-4xl font-bold bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-400 bg-clip-text text-transparent tracking-tight flex items-center gap-3">
            <Sigma className="text-blue-400" /> EtherGBM
          </h1>
          <p className="text-slate-500 text-sm mt-2 font-medium">
            Geometric Brownian Motion - Stochastic Ethereum Dashboard
          </p>
        </div>
        
        <div className="flex items-center gap-8">
          {/* Volatility Indicator */}
           <div className="text-right hidden sm:block">
            <div className="flex items-center justify-end gap-2 mb-1">
              <span className="text-xs uppercase tracking-wider text-slate-500 font-bold">Volatility (σ)</span>
              {!useLiveVol && <span className="text-[10px] text-blue-400 bg-blue-500/10 px-1 rounded border border-blue-500/20">MANUAL</span>}
              {useLiveVol && isVolEstimated && <span className="text-[10px] text-yellow-500 bg-yellow-500/10 px-1 rounded border border-yellow-500/20">EST</span>}
            </div>
            <div className={`text-2xl font-mono ${useLiveVol ? 'text-slate-300' : 'text-blue-300'}`}>
              {activeVolatility.toFixed(2)}%
            </div>
          </div>

          {/* Price Indicator */}
          <div className="text-right">
            <div className="flex items-center justify-end gap-2 mb-1">
              <span className="text-xs uppercase tracking-wider text-slate-500 font-bold">ETH / USDT</span>
              {isConnected ? <Wifi size={14} className="text-emerald-500 animate-pulse" /> : <WifiOff size={14} className="text-red-500" />}
            </div>
            <div className="text-4xl font-mono text-white tracking-tighter shadow-blue-500/20 drop-shadow-lg">
              {formatCurrency(livePrice)}
            </div>
          </div>
        </div>
      </div>

      {/* CONTENT GRID */}
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 relative z-10">
        
        {/* LEFT COLUMN: VISUALIZATION & PROOF (8 Cols) */}
        <div className="lg:col-span-8 flex flex-col gap-6">
          
          {/* CHART */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-1 shadow-2xl h-[450px] relative flex flex-col overflow-hidden">
             
             {/* Legend Overlay */}
             <div className="absolute top-4 left-6 z-20 flex gap-4 pointer-events-none">
               <div className="flex items-center gap-2">
                 <div className="w-3 h-0.5 bg-blue-500"></div>
                 <span className="text-[10px] text-slate-400 font-mono uppercase">Price Action</span>
               </div>
               <div className="flex items-center gap-2">
                 <div className="flex gap-0.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500"></div>
                    <div className="w-1.5 h-1.5 rounded-full bg-purple-500"></div>
                 </div>
                 <span className="text-[10px] text-slate-400 font-mono uppercase">Field of Vision (1-3σ)</span>
               </div>
               <div className="flex items-center gap-2">
                 <div className="w-3 h-0 border-t border-dashed border-emerald-400"></div>
                 <span className="text-[10px] text-slate-400 font-mono uppercase">Target</span>
               </div>
             </div>

             <div className="flex-1 w-full min-h-0 pt-4 pr-4">
               <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={chartData}>
                    <defs>
                      <linearGradient id="sigma3Gradient" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#7e22ce" stopOpacity={0.08}/> {/* Purple */}
                        <stop offset="100%" stopColor="#7e22ce" stopOpacity={0.02}/>
                      </linearGradient>
                      <linearGradient id="sigma2Gradient" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#4338ca" stopOpacity={0.15}/> {/* Indigo */}
                        <stop offset="100%" stopColor="#4338ca" stopOpacity={0.05}/>
                      </linearGradient>
                      <linearGradient id="sigma1Gradient" x1="0" y1="0" x2="1" y2="0">
                        <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.25}/> {/* Sky Blue */}
                        <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.1}/>
                      </linearGradient>
                    </defs>
                    
                    <CartesianGrid strokeDasharray="2 6" stroke="#1e293b" vertical={false} />
                    
                    <XAxis 
                      dataKey="timestamp" 
                      type="number" 
                      domain={['dataMin', 'dataMax']} 
                      tickFormatter={(unix) => new Date(unix).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                      stroke="#334155"
                      tick={{fill: '#64748b', fontSize: 10}}
                      minTickGap={40}
                      axisLine={false}
                    />
                    
                    <YAxis 
                      domain={['auto', 'auto']} 
                      orientation="right" 
                      stroke="#334155"
                      tick={{fill: '#64748b', fontSize: 10}}
                      tickFormatter={(val) => `$${val.toFixed(0)}`}
                      width={60}
                      axisLine={false}
                    />
                    
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '4px', color: '#f8fafc' }}
                      itemStyle={{ fontSize: '12px', fontFamily: 'monospace' }}
                      labelFormatter={(l) => new Date(l).toLocaleTimeString()}
                      formatter={(val: any, name) => {
                         if(val == null) return [undefined, undefined];
                         if(Array.isArray(val)) return [`$${val[0].toFixed(2)} - $${val[1].toFixed(2)}`, name];
                         return [`$${Number(val).toFixed(2)}`, name];
                      }}
                    />
                    
                    {/* Z-Order: Render widest cone first (background) */}
                    <Area type="monotone" dataKey="sigma3" stroke="none" fill="url(#sigma3Gradient)" name="3σ (99.7%)" connectNulls={true} />
                    <Area type="monotone" dataKey="sigma2" stroke="none" fill="url(#sigma2Gradient)" name="2σ (95%)" connectNulls={true} />
                    <Area type="monotone" dataKey="sigma1" stroke="none" fill="url(#sigma1Gradient)" name="1σ (68%)" connectNulls={true} />
                    
                    <Line type="monotone" dataKey="mean" stroke="#a5b4fc" strokeWidth={1} strokeDasharray="3 3" strokeOpacity={0.5} dot={false} name="Mean" connectNulls={true} />
                    
                    <ReferenceLine y={targetPrice} stroke={targetPrice > livePrice ? "#10b981" : "#ef4444"} strokeDasharray="4 2" strokeOpacity={0.8} />

                    {/* The Snake (Live Price) */}
                    <Line 
                      type="monotone" 
                      dataKey="price" 
                      stroke="#3b82f6" 
                      strokeWidth={3} 
                      dot={(props) => <PulsingDot {...props} dataLength={history.length} />}
                      name="ETH Price" 
                      connectNulls={false}
                      isAnimationActive={false}
                    />

                    <Brush 
                      dataKey="timestamp" 
                      height={20} 
                      stroke="#3b82f6" 
                      fill="#0f172a" 
                      tickFormatter={() => ''} 
                      fillOpacity={0.2}
                    />
                  </ComposedChart>
               </ResponsiveContainer>
             </div>
          </div>

          {/* QUANT NOTEBOOK: SHOW YOUR WORK */}
          {model && (
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-xl relative overflow-hidden">
              <div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-blue-500 to-indigo-500"></div>
              
              <div className="flex items-center gap-2 mb-6 text-slate-200">
                <BookOpen size={18} className="text-blue-400"/>
                <h3 className="font-bold text-lg">Solution Notebook</h3>
              </div>

              {/* Natural Language Problem Statement */}
              <div className="mb-6 bg-slate-950 p-4 rounded-lg border border-slate-800/50 text-slate-300 font-mono text-sm leading-relaxed">
                <span className="text-blue-400 font-bold mr-2">QUERY &gt;</span>
                "If the price of ETH is <span className="text-white font-bold">${livePrice.toFixed(2)}</span>, 
                what is the probability that it will be <span className={model.direction === 'above' ? 'text-emerald-400' : 'text-red-400'}>{model.direction}</span> 
                <span className="text-white font-bold"> ${targetPrice}</span> in <span className="text-white font-bold">{timeMinutes} minutes</span>?"
              </div>

              {/* Math Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <div>
                   <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4 border-b border-slate-800 pb-2">1. Variables</h4>
                   <div className="grid grid-cols-2 gap-y-2 text-sm font-mono text-slate-400">
                      <span>Price (S₀)</span> <span className="text-white text-right">{livePrice.toFixed(2)}</span>
                      <span>Target (K)</span> <span className="text-white text-right">{targetPrice}</span>
                      <span>Volatility (σ)</span> <span className="text-white text-right">{activeVolatility.toFixed(2)}%</span>
                      <span>Time (t)</span> <span className="text-white text-right">{model.t_years.toFixed(6)} yrs</span>
                      <span>Bias (μ)</span> <span className={`text-right ${bias === 'bull' ? 'text-emerald-400' : bias === 'bear' ? 'text-red-400' : 'text-slate-500'}`}>{model.mu.toFixed(3)}</span>
                   </div>
                </div>

                <div>
                   <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-4 border-b border-slate-800 pb-2">2. Execution</h4>
                   
                   <MathStep 
                      label="A. Log Distance" 
                      formula="ln(K / S₀)" 
                      result={model.logReturn.toFixed(5)} 
                   />

                   <MathStep 
                      label="B. Drift Adjusted" 
                      formula="(μ - 0.5σ²) * t" 
                      result={model.driftTerm.toFixed(5)} 
                      desc="Ito's correction applied to drift over time t."
                   />

                   <MathStep 
                      label="C. Z-Score" 
                      formula="(LogDist - Drift) / (σ√t)" 
                      result={model.zScore.toFixed(4)} 
                      desc="Standard deviations away from the mean."
                   />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: CONTROLS (4 Cols) */}
        <div className="lg:col-span-4 space-y-6">
          
          {/* CONTROL PANEL */}
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-6 shadow-xl space-y-6">
            <div className="flex items-center gap-2 text-white font-semibold pb-4 border-b border-slate-800">
               <Settings className="text-blue-500" size={18} /> Model Parameters
            </div>

            {/* Drift Bias */}
            <div>
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Market Bias (Drift)</label>
              <div className="grid grid-cols-3 bg-slate-950 p-1 rounded-lg border border-slate-800">
                <button onClick={() => setBias('bear')} className={`py-2 rounded-md text-xs font-medium flex items-center justify-center gap-1 ${bias === 'bear' ? 'bg-red-900/30 text-red-400 border border-red-500/30' : 'text-slate-500 hover:text-slate-300'}`}><TrendingDown size={14} /> Bear</button>
                <button onClick={() => setBias('neutral')} className={`py-2 rounded-md text-xs font-medium ${bias === 'neutral' ? 'bg-slate-700 text-white' : 'text-slate-500 hover:text-slate-300'}`}>Neutral</button>
                <button onClick={() => setBias('bull')} className={`py-2 rounded-md text-xs font-medium flex items-center justify-center gap-1 ${bias === 'bull' ? 'bg-emerald-900/30 text-emerald-400 border border-emerald-500/30' : 'text-slate-500 hover:text-slate-300'}`}><TrendingUp size={14} /> Bull</button>
              </div>
            </div>

            {/* Volatility */}
            <div>
              <div className="flex justify-between mb-2">
                 <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Volatility Source</label>
                 <button 
                  onClick={() => setUseLiveVol(!useLiveVol)} 
                  className="text-[10px] font-mono text-blue-400 hover:text-blue-300 underline cursor-pointer"
                 >
                   {useLiveVol ? 'Switch to Manual' : 'Switch to Live'}
                 </button>
              </div>
              
              {useLiveVol ? (
                 <div className="bg-slate-950 border border-slate-800 rounded px-3 py-2 text-slate-400 text-sm font-mono flex justify-between items-center opacity-70">
                    <span>API (Deribit)</span>
                    <span>{liveVol.toFixed(2)}%</span>
                 </div>
              ) : (
                <div className="space-y-2">
                   <div className="flex gap-2">
                      <input 
                        type="number" 
                        value={manualVol} 
                        onChange={(e) => setManualVol(parseFloat(e.target.value))}
                        className="bg-slate-950 border border-slate-700 rounded px-3 py-2 text-white font-mono text-sm w-full focus:border-blue-500 outline-none"
                      />
                      <span className="flex items-center text-slate-500 font-mono text-xs">%</span>
                   </div>
                   <input 
                      type="range" min="10" max="200" step="1" 
                      value={manualVol} onChange={(e) => setManualVol(parseFloat(e.target.value))}
                      className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                   />
                </div>
              )}
            </div>

            {/* Target Price */}
            <div>
               <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Target Price ($)</label>
               <div className="relative">
                 <input 
                    type="number"
                    value={targetPrice}
                    onChange={(e) => setTargetPrice(parseFloat(e.target.value) || 0)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg py-3 px-4 text-white font-mono focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none transition-all"
                 />
                 <div className="absolute right-3 top-3.5 text-xs font-medium">
                   {targetPrice > livePrice ? 
                      <span className="text-emerald-500 flex items-center gap-1">Call</span> : 
                      <span className="text-red-500 flex items-center gap-1">Put</span>
                   }
                 </div>
               </div>
            </div>

            {/* Time */}
            <div>
               <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Time Horizon ({timeMinutes} min)</label>
               <input 
                  type="range"
                  min="1"
                  max="1440" 
                  value={timeMinutes}
                  onChange={(e) => setTimeMinutes(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-slate-800 rounded-full appearance-none cursor-pointer accent-blue-500"
               />
            </div>
          </div>

          {/* FINAL RESULT CARD */}
          <div className="relative overflow-hidden rounded-lg border border-blue-500/30 shadow-[0_0_30px_rgba(37,99,235,0.15)] group">
             <div className="absolute inset-0 bg-gradient-to-br from-indigo-950 to-slate-950 z-0"></div>
             
             <div className="relative z-10 p-6 flex flex-col items-center text-center">
               <div className="w-16 h-16 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center mb-4 shadow-inner">
                  <Calculator className="text-blue-400" size={24} />
               </div>

               <h3 className="text-slate-400 text-sm font-medium mb-1 uppercase tracking-widest">Final Probability</h3>
               <div className="text-5xl font-bold text-white tracking-tight mb-2 font-mono">
                 {model ? (model.probability * 100).toFixed(2) : '0.0'}%
               </div>

               <p className="text-xs text-slate-500 leading-relaxed max-w-[240px]">
                 Based on {activeVolatility.toFixed(0)}% volatility and GBM distribution.
               </p>
             </div>
          </div>

        </div>
      </div>
    </div>
  );
};

export default EtherQuantDashboard;
import React, { useState } from 'react';
import { 
  Users, FileText, MessageSquare, Activity, 
  ShieldCheck, AlertTriangle, ChevronDown, 
  Code, LayoutTemplate, Clock, Database
} from 'lucide-react';

export default function AsYouSaidPlatform() {
  const [xrayMode, setXrayMode] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);

  return (
    <div className="h-screen w-full flex bg-slate-50 text-slate-900 font-sans overflow-hidden">
      
      {/* 1. BAL OLDALI SÁV (Navigáció & Erőforrások) */}
      <div className="w-64 bg-slate-900 text-slate-300 flex flex-col justify-between shrink-0 shadow-lg z-20">
        <div>
          {/* Projekt Selector */}
          <div className="p-4 border-b border-slate-800 flex items-center justify-between cursor-pointer hover:bg-slate-800 transition-colors">
            <div className="font-semibold text-white truncate">Acme Corp Brand Test</div>
            <ChevronDown size={16} />
          </div>
          
          {/* Navigációs Menü */}
          <nav className="p-4 space-y-1">
            <button className="w-full flex items-center gap-3 px-3 py-2 bg-indigo-600 text-white rounded-md font-medium">
              <FileText size={18} />
              Kérdőívek (Runs)
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-800 rounded-md transition-colors">
              <Users size={18} />
              Perszóna Katalógus
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-800 rounded-md transition-colors">
              <MessageSquare size={18} />
              Interjú Mód
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 hover:bg-slate-800 rounded-md transition-colors">
              <Database size={18} />
              Modellek / Kalibráció
            </button>
          </nav>
        </div>

        {/* Live Status / Token Budget */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/50">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-medium uppercase tracking-wider text-slate-400">Token Budget</span>
            <span className="text-xs font-mono text-emerald-400">$12.45 / $50</span>
          </div>
          <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
            <div className="bg-indigo-500 h-full w-1/4 rounded-full"></div>
          </div>
        </div>
      </div>

      {/* 2. KÖZÉPSŐ TÉR (Munkaterület) */}
      <div className="flex-1 flex flex-col min-w-0 z-10 relative">
        {/* Fejléc & X-Ray Toggle */}
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between shrink-0 shadow-sm z-10">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">Szoftverfejlesztési preferenciák - V2</h1>
            <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
              <span className="flex items-center gap-1"><Activity size={12} className="text-emerald-500"/> Párhuzamos hívások: 8/12</span>
              <span>•</span>
              <span>Cache hit: 43%</span>
            </div>
          </div>

          {/* Toggle */}
          <div className="flex items-center bg-slate-100 p-1 rounded-lg border border-slate-200">
            <button 
              onClick={() => setXrayMode(false)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${!xrayMode ? 'bg-white shadow-sm text-indigo-600' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <LayoutTemplate size={16} />
              Elemző
            </button>
            <button 
              onClick={() => setXrayMode(true)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${xrayMode ? 'bg-slate-900 shadow-sm text-white' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <Code size={16} />
              Mérnök (X-Ray)
            </button>
          </div>
        </header>

        {/* Tartalom (Görgethető) */}
        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-4xl mx-auto space-y-6">
            
            {/* Kérdés blokk */}
            <div className="mb-8">
              <h2 className="text-xl font-medium text-slate-800 mb-2">Q3: Melyik keretrendszert részesíti előnyben új projekteknél?</h2>
              <p className="text-sm text-slate-500">Mód: Style C (Eloszlás) • Memóriatörlés: Aktív</p>
            </div>

            <div className="grid grid-cols-1 gap-4">
              
              {/* Sikeres Válasz Kártya */}
              <div className="bg-white border border-slate-200 rounded-lg shadow-sm overflow-hidden cursor-pointer hover:border-indigo-300 transition-colors" onClick={() => setInspectorOpen(true)}>
                <div className="p-4 flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-sm shrink-0">
                    BR
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between items-center mb-1">
                      <h3 className="font-semibold text-slate-900">Béla, a szkeptikus IT-s</h3>
                      <span className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-md border border-slate-200">V1.2</span>
                    </div>
                    {/* Elemző nézet: Csak az eredmény */}
                    {!xrayMode && (
                      <div className="mt-3">
                        <div className="w-full bg-slate-100 h-6 rounded-md overflow-hidden flex text-xs text-white font-medium">
                          <div className="bg-indigo-600 h-full flex items-center justify-center" style={{width: '70%'}}>React (70%)</div>
                          <div className="bg-indigo-400 h-full flex items-center justify-center" style={{width: '20%'}}>Vue (20%)</div>
                          <div className="bg-slate-400 h-full flex items-center justify-center" style={{width: '10%'}}>Egyéb</div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                
                {/* X-Ray Nézet (Kibontva) */}
                {xrayMode && (
                  <div className="bg-slate-900 text-slate-300 text-xs p-4 border-t border-slate-800 font-mono">
                    <div className="grid grid-cols-2 gap-4 mb-4">
                      <div><span className="text-slate-500">Model:</span> deepseek-v4-flash-0731</div>
                      <div><span className="text-slate-500">Temp:</span> 0.2</div>
                      <div><span className="text-slate-500">Tokenek:</span> <span className="text-emerald-400">145 in / 28 out</span></div>
                      <div><span className="text-slate-500">Permutáció:</span> C, A, B, D</div>
                    </div>
                    <div className="text-slate-500 mb-1">Raw Output:</div>
                    <div className="bg-slate-950 p-2 rounded text-slate-400">
                      {`{ "React": 0.7, "Vue": 0.2, "Angular": 0.05, "Svelte": 0.05 }`}
                    </div>
                  </div>
                )}
              </div>

              {/* Evidentiary Gap Kártya */}
              <div className="bg-amber-50 border border-amber-200 border-l-4 border-l-amber-500 rounded-lg shadow-sm overflow-hidden cursor-pointer" onClick={() => setInspectorOpen(true)}>
                <div className="p-4 flex items-start gap-4">
                  <div className="w-10 h-10 rounded-full bg-white text-amber-500 flex items-center justify-center shrink-0 border border-amber-200 shadow-sm">
                    <AlertTriangle size={20} />
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between items-center mb-1">
                      <h3 className="font-semibold text-slate-900">Emma, a HR menedzser</h3>
                      <span className="text-xs bg-amber-100 text-amber-800 px-2 py-1 rounded-md font-medium border border-amber-200">Tartózkodás</span>
                    </div>
                    <p className="text-sm text-amber-800 mt-1">
                      Ennek a perszónának a definíciójában nincs elegendő bizonyíték a 'Szoftverfejlesztési keretrendszerek' témakörhöz.
                    </p>
                  </div>
                </div>

                {/* X-Ray Nézet Evidentiary Gap esetén */}
                {xrayMode && (
                  <div className="bg-slate-900 text-slate-300 text-xs p-4 border-t border-amber-500/30 font-mono">
                    <div className="flex items-center gap-2 mb-2 text-amber-400">
                      <Activity size={14} /> Kalibrációs Profil Figyelmeztetés
                    </div>
                    <p className="text-slate-400">
                      A default modell kalibrációja szerint erre a kérdésre 85%-ban invalid (vagy random) választ ad profilhoz kötött technikai ismeret hiányában. A rendszer explicit tartózkodásra kényszerítette az ágenst a hallucináció elkerülése végett.
                    </p>
                  </div>
                )}
              </div>

            </div>
          </div>
        </main>
      </div>

      {/* 3. JOBB OLDALI SÁV (Inspector / Provenance Card) */}
      {inspectorOpen && (
        <aside className="w-80 bg-white border-l border-slate-200 shadow-2xl flex flex-col shrink-0 z-30 transform transition-transform">
          <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
            <h3 className="font-semibold text-slate-800 text-sm uppercase tracking-wider">Persona Provenance</h3>
            <button onClick={() => setInspectorOpen(false)} className="text-slate-400 hover:text-slate-600">
              <ChevronDown size={18} className="rotate-90" />
            </button>
          </div>
          
          <div className="p-6 flex-1 overflow-y-auto">
            {/* Header */}
            <div className="text-center mb-6">
              <div className="w-20 h-20 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-2xl mx-auto mb-3 border-4 border-white shadow-sm">
                BR
              </div>
              <h2 className="text-xl font-bold text-slate-900">Béla, a szkeptikus</h2>
              <p className="text-sm text-slate-500 mt-1">Szenior IT Architekt</p>
            </div>

            {/* Bizonyíték / Grounding Badge */}
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 mb-6 flex items-start gap-3">
              <ShieldCheck className="text-emerald-600 shrink-0 mt-0.5" size={18} />
              <div>
                <h4 className="text-xs font-bold text-emerald-800 uppercase tracking-wide mb-1">Grounded Profil</h4>
                <p className="text-xs text-emerald-700 leading-relaxed">
                  Forrás: 2023-as StackOverflow Developer Survey és 12 valós ügyfélinterjú tranzkriptuma. Nem-fiktív generálás.
                </p>
              </div>
            </div>

            {/* Demográfia Címkék */}
            <div className="mb-6">
              <h4 className="text-xs font-semibold text-slate-900 uppercase tracking-wider mb-3">Demográfia</h4>
              <div className="flex flex-wrap gap-2">
                <span className="px-2.5 py-1 bg-slate-100 text-slate-600 text-xs rounded-md border border-slate-200">Budapest</span>
                <span className="px-2.5 py-1 bg-slate-100 text-slate-600 text-xs rounded-md border border-slate-200">45-55 év</span>
                <span className="px-2.5 py-1 bg-slate-100 text-slate-600 text-xs rounded-md border border-slate-200">Férfi</span>
                <span className="px-2.5 py-1 bg-slate-100 text-slate-600 text-xs rounded-md border border-slate-200">Szenior</span>
              </div>
            </div>

            {/* Metaadatok */}
            <div>
              <h4 className="text-xs font-semibold text-slate-900 uppercase tracking-wider mb-3">Rendszer Metaadatok</h4>
              <ul className="space-y-2 text-xs text-slate-600">
                <li className="flex justify-between border-b border-slate-100 pb-1">
                  <span className="text-slate-400">Verzió</span>
                  <span className="font-medium">v1.2 (2025.10.12)</span>
                </li>
                <li className="flex justify-between border-b border-slate-100 pb-1">
                  <span className="text-slate-400">Prompt Mód</span>
                  <span className="font-medium text-indigo-600">System Constraint</span>
                </li>
                <li className="flex justify-between border-b border-slate-100 pb-1">
                  <span className="text-slate-400">Alap Modell</span>
                  <span className="font-medium">deepseek-v4</span>
                </li>
              </ul>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
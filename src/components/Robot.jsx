import React from 'react';

export default function Robot({ large = false }) {
  return <svg className={`robot ${large ? 'large-robot' : ''}`} viewBox="0 0 160 185" role="img" aria-label="Four-wheeled robotic vehicle">
    <defs>
      <linearGradient id="body" x1="0" x2="1"><stop stopColor="#203644"/><stop offset=".45" stopColor="#45606e"/><stop offset="1" stopColor="#203644"/></linearGradient>
      <linearGradient id="tire" x1="0" x2="1"><stop stopColor="#111b25"/><stop offset=".5" stopColor="#31414d"/><stop offset="1" stopColor="#101921"/></linearGradient>
    </defs>
    <ellipse cx="80" cy="171" rx="61" ry="7" fill="#dce6e9"/>
    {[20,115].flatMap((x) => [12,119].map(y => <g key={`${x}-${y}`}><rect x={x} y={y} width="27" height="52" rx="9" fill="url(#tire)"/>{Array.from({length:7},(_,i)=><path key={i} d={`M${x+2} ${y+6+i*6}l11 3 12-4`} stroke="#51616b" strokeWidth="1.8" opacity=".55"/>)}</g>))}
    <path d="M34 38h95M34 145h95" stroke="#4d616c" strokeWidth="8"/>
    <path d="M57 24h48l12 15v116l-14 10H59l-15-10V39Z" fill="url(#body)" stroke="#223d4e" strokeWidth="2"/>
    <rect x="64" y="17" width="32" height="15" rx="5" fill="#182a36"/>
    <rect x="65" y="40" width="31" height="54" rx="4" fill="#142a35" stroke="#5a7583"/>
    <path d="M72 48h17v37H72z" fill="#00b69a" opacity=".8"/>
    <rect x="58" y="112" width="45" height="25" rx="4" fill="#1b303c"/>
    <circle cx="80" cy="105" r="4" fill="#91a4ae"/>
  </svg>;
}

'use strict';
// Gift notes are printed on the packing slip card (Jonah, 23 Nov 2026: "they can add a note to it saying anything non
// vulgar"). This is a plain word check, best effort: it looks for swear words and slurs at the start of a word, also when
// written with symbols (f*ck, sh!t, $hit), stretched (fuuuck) or spaced out (f u c k). Names and ordinary words that only
// contain those letters (Dickens, Cassidy, class, peacock, cocktail, shiitake, Scunthorpe, Niger) are left alone.
const LEET={'@':'a','4':'a','$':'s','5':'s','0':'o','1':'i','!':'i','3':'e','7':'t','+':'t','€':'e','|':'i'};
const BAD=[
 /f+[u*v]+c+k+/, /(?:bull|horse|dip|chicken|ape|holy|jack)\s*s+h+[i*]+t+/, /\bf+[*]+[ck*]+/, /\bf+u+k+(?:e+r+|i+n+g*)?\b/, /\bf+c+k+\b/, /\bf+k+\b/, /\bw+t+f+\b/, /\bs+t+f+u+\b/,
 /\bmother\s*f/, /\bs+h+[i*]+t+(?!ake)/, /\bsh\*+t/, /\bb+[i*]+t+c+h+/, /\bc+u+n+t+/, /\bd+i+c+k+(?:h+e+a+d+|s+u+c+k)/,
 /\bc+o+c+k+s*\b/, /\bc+o+c+k+s+u+c+k/, /\bp+u+s+s+y+\b/, /\ba+s+s+h+o+l+e+/, /\b(?:jack|dumb|smart|bad|kiss my)\s*a+s+s+\b/,
 /\bb+a+s+t+a+r+d+/, /\bs+l+u+t+/, /\bw+h+o+r+e+/, /\bt+w+a+t+/, /\bw+a+n+k+/, /\bp+r+i+c+k+s?\b/, /\bt+i+t+s+\b/, /\bt+i+t+t+i+e+s*/,
 /\bb+o+o+b+s*\b/, /\bc+u+m+\b/, /\bj+i+z+z+/, /\bd+i+l+d+o+/, /\bp+o+r+n+/, /\bh+o+r+n+y+\b/, /\bb+l+o+w+\s*j+o+b+/, /\bh+a+n+d+\s*j+o+b+/,
 /\bp+e+n+i+s+/, /\bv+a+g+i+n+a+/, /\bs+e+x+\b/, /\bn+i+g+g+/, /\bn+i+g+a+s?\b/, /\bf+a+g+s*\b/, /\bf+a+g+g?o+t+/, /\bd+y+k+e+s*\b/,
 /\bs+p+i+c+s*\b/, /\bc+h+i+n+k+s*\b/, /\bk+i+k+e+s*\b/, /\bw+e+t+b+a+c+k+/, /\br+e+t+a+r+d+(?:e+d+|s+)?\b/, /\bt+r+a+n+n+y+/,
 /\bk+i+l+l+\s+y+o+u+r+s+e+l+f+/, /\bk+y+s+\b/,
];
function forms(text){
 const lower=String(text||'').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g,'');
 const leet=lower.replace(/[@4$50!13€7+|]/g,c=>LEET[c]||c);
 // f u c k / f.u.c.k / f-u-c-k: letters one apart joined back together.
 const joined=leet.replace(/\b(?:[a-z*][^a-z0-9*\n]){2,}[a-z*]\b/g,m=>m.replace(/[^a-z*]/g,''));
 return [lower,leet,joined];
}
function isVulgar(text){const all=forms(text);return BAD.some(re=>all.some(f=>re.test(f)))}
module.exports={isVulgar};

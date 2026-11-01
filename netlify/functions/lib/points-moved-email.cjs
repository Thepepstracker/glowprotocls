'use strict';
// "Your Glow Points moved with you" email (Jonah, 1 Nov 2026). One personal email per old-site customer whose
// carried-over balance is waiting in rewards_imports. Colors use bgcolor + background-color (kept by Gmail and
// Outlook); the gold card adds a gradient for apps that support it, with solid gold as the fallback.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const F="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",S="font-family:Georgia,'Times New Roman',serif";
const CLAIM='https://glowglps.com/store-next/account#customer-forgot';
function firstName(v){const w=String(v||'').trim().split(/\s+/)[0]||'';if(!/^[A-Za-zÀ-ÿ'’-]{2,20}$/.test(w))return '';return w.charAt(0).toUpperCase()+w.slice(1).toLowerCase()}
function num(n){return `<table role="presentation" cellpadding="0" cellspacing="0" width="30" height="30"><tr><td width="30" height="30" align="center" valign="middle" bgcolor="#141414" style="background-color:#141414;border-radius:15px;color:#f3d58b;${F};font-size:14px;font-weight:700;">${n}</td></tr></table>`}
function step(n,html,last){return `<tr><td width="66" valign="top" style="padding:8px 12px ${last?20:8}px 24px;">${num(n)}</td><td valign="top" style="padding:12px 24px ${last?20:8}px 0;${F};font-size:15px;line-height:1.5;color:#3b3833;">${html}</td></tr>`}
function content({first_name,points,email}){
 const first=firstName(first_name),pts=Number(points).toLocaleString('en-US'),dollars='$'+(points*0.05).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,',');
 const subject=(first?first+', your ':'Your ')+pts+' Glow Points moved with you';
 const heading=(first?esc(first)+', your':'Your')+' Glow&nbsp;Points are waiting for you.';
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"><title>Your Glow Points moved with you</title></head>
<body style="margin:0;padding:0;background-color:#f4efe6;" bgcolor="#f4efe6">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#f4efe6;">Every point you earned came with us to our new store. Claim them in under a minute.&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f4efe6" style="background-color:#f4efe6;"><tr><td align="center" style="padding:28px 12px 40px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:22px;box-shadow:0 2px 0 #e6dccb;">
<tr><td align="center" bgcolor="#141414" style="background-color:#141414;padding:30px 24px 26px;border-radius:22px 22px 0 0;">
<div style="${S};font-size:13px;letter-spacing:6px;color:#c9a24b;">&#9670;&nbsp;&nbsp;GLOW&nbsp;LAB&nbsp;&nbsp;&#9670;</div>
<div style="${F};font-size:10px;letter-spacing:4px;color:#8a8273;padding-top:6px;">PROTOCOLS</div></td></tr>
<tr><td height="4" bgcolor="#c9a24b" style="background-color:#c9a24b;height:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td align="center" style="padding:40px 36px 8px;">
<div style="${F};font-size:12px;font-weight:700;letter-spacing:3px;color:#a88433;">YOUR POINTS MADE THE MOVE</div>
<h1 style="margin:14px 0 0;${S};font-weight:normal;font-size:34px;line-height:1.2;color:#1b1b1b;">${heading}</h1></td></tr>
<tr><td align="center" style="padding:28px 36px 6px;">
<table role="presentation" width="420" cellpadding="0" cellspacing="0" bgcolor="#c9a24b" style="width:100%;max-width:420px;background-color:#c9a24b;background-image:linear-gradient(135deg,#e9cf8a 0%,#c9a24b 45%,#9c7a2e 100%);border-radius:18px;"><tr><td align="center" style="padding:30px 24px 28px;">
<div style="${F};font-size:11px;font-weight:700;letter-spacing:3px;color:#3a2c0c;">YOUR BALANCE</div>
<div style="${S};font-size:64px;line-height:1.05;color:#141414;padding-top:6px;">${pts}</div>
<div style="${F};font-size:13px;font-weight:700;letter-spacing:4px;color:#3a2c0c;padding-top:2px;">GLOW POINTS</div>
<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:18px auto 0;"><tr><td bgcolor="#141414" style="background-color:#141414;border-radius:999px;padding:9px 18px;${F};font-size:16px;font-weight:700;color:#f3d58b;white-space:nowrap;">Worth ${dollars} off</td></tr></table>
<div style="${F};font-size:13px;color:#3a2c0c;padding-top:10px;">on your next order</div></td></tr></table></td></tr>
<tr><td style="padding:26px 44px 4px;${F};font-size:16px;line-height:1.65;color:#3b3833;">
<p style="margin:0 0 14px;">Glow Lab has moved to a brand-new store at <strong style="color:#1b1b1b;">glowglps.com</strong>, and we brought your rewards with us. Every point you earned is safe and ready to use.</p>
<p style="margin:0;">Your old password didn't come across, so it takes one quick step to claim them.</p></td></tr>
<tr><td align="center" style="padding:28px 36px 10px;">
<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr><td align="center" bgcolor="#141414" style="background-color:#141414;border-radius:999px;">
<a href="${CLAIM}" style="display:inline-block;padding:17px 38px;${F};font-size:17px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">Claim my points &rarr;</a></td></tr></table></td></tr>
<tr><td style="padding:22px 36px 6px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f8f4ec" style="background-color:#f8f4ec;border:1px solid #ece4d4;border-radius:16px;">
<tr><td colspan="2" style="padding:22px 24px 8px;${F};font-size:12px;font-weight:700;letter-spacing:3px;color:#a88433;">HOW IT WORKS</td></tr>
${step(1,'Tap <strong>Claim my points</strong>.')}
${step(2,'Enter the email you always order with: <strong style="color:#1b1b1b;">'+esc(email)+'</strong>')}
${step(3,'Open the link we email you and choose a password. Your points show up right away.',true)}
</table></td></tr>
<tr><td style="padding:18px 36px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${F};text-align:center;"><tr>
<td width="33%" style="padding:10px 4px;"><div style="${S};font-size:22px;color:#1b1b1b;">1 pt</div><div style="font-size:12px;color:#8a8273;padding-top:2px;">for every $1</div></td>
<td width="34%" style="padding:10px 4px;border-left:1px solid #ece4d4;border-right:1px solid #ece4d4;"><div style="${S};font-size:22px;color:#1b1b1b;">$5 off</div><div style="font-size:12px;color:#8a8273;padding-top:2px;">every 100 points</div></td>
<td width="33%" style="padding:10px 4px;"><div style="${S};font-size:22px;color:#1b1b1b;">Never</div><div style="font-size:12px;color:#8a8273;padding-top:2px;">do they expire</div></td></tr></table></td></tr>
<tr><td style="padding:24px 44px 34px;${F};font-size:16px;line-height:1.65;color:#3b3833;">
<p style="margin:0 0 14px;">Thank you for being part of Glow Lab. Questions? Just reply to this email. A real person reads every one.</p>
<p style="margin:0;${S};font-size:18px;color:#1b1b1b;">Heather &amp; Jonah</p><p style="margin:2px 0 0;font-size:13px;color:#8a8273;">Glow Lab Protocols</p></td></tr>
<tr><td align="center" bgcolor="#141414" style="background-color:#141414;padding:22px 28px;${F};font-size:12px;line-height:1.6;color:#8a8273;border-radius:0 0 22px 22px;">
<a href="https://glowglps.com" style="color:#c9a24b;text-decoration:none;font-weight:700;letter-spacing:1px;">glowglps.com</a><br>You're getting this because you have a Glow Points balance from a past order.<br>Glow Lab Protocols &middot; Ball Ground, GA</td></tr>
</table></td></tr></table></body></html>`;
 const text=[(first?first+', your':'Your')+' Glow Points are waiting for you.','',`Your balance: ${pts} Glow Points, worth ${dollars} off your next order.`,'','Glow Lab has moved to a brand-new store at glowglps.com, and we brought your rewards with us. Every point you earned is safe and ready to use. Your old password didn\'t come across, so it takes one quick step to claim them.','','Claim my points: '+CLAIM,'','How it works:','1. Tap Claim my points.','2. Enter the email you always order with: '+email,'3. Open the link we email you and choose a password. Your points show up right away.','','1 point for every $1. $5 off every 100 points. Points never expire.','','Thank you for being part of Glow Lab. Questions? Just reply to this email. A real person reads every one.','','Heather & Jonah','Glow Lab Protocols','glowglps.com · Ball Ground, GA'].join('\n');
 return{subject,html,text};
}
module.exports={content,firstName};

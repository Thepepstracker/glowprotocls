'use strict';
// Glow's own street addresses and phone numbers must never become a customer's ship-to.
// A browser on a staff phone or laptop can autofill the family's home address and the business
// phone into a customer's order (GLP-9E78E98CEC, 5 Oct 2026, was delivered to the house).
// The values live in Netlify environment variables, never in this public repository:
//   STORE_OWN_ADDRESSES = street lines separated by |    e.g. "1 Example Lane|2 Sample St"
//   STORE_OWN_PHONES    = phone numbers separated by |
const SUFFIX={street:'st',st:'st',lane:'ln',ln:'ln',road:'rd',rd:'rd',drive:'dr',dr:'dr',avenue:'ave',ave:'ave',av:'ave',court:'ct',ct:'ct',circle:'cir',cir:'cir',boulevard:'blvd',blvd:'blvd',highway:'hwy',hwy:'hwy',parkway:'pkwy',pkwy:'pkwy',place:'pl',pl:'pl',trail:'trl',trl:'trl',way:'way',terrace:'ter',ter:'ter',north:'n',n:'n',south:'s',s:'s',east:'e',e:'e',west:'w',w:'w'};
function street(v){return String(v||'').toLowerCase().replace(/[.,#]/g,' ').split(/\s+/).filter(Boolean).map(w=>SUFFIX[w]||w).join(' ')}
const digits=v=>String(v||'').replace(/\D/g,'').slice(-10);
function lists(){return{addresses:String(process.env.STORE_OWN_ADDRESSES||'').split('|').map(street).filter(a=>a.length>=6),phones:String(process.env.STORE_OWN_PHONES||'').split('|').map(digits).filter(p=>p.length===10)}}
// Returns 'address', 'phone' or '' for a customer object.
function match(c){const {addresses,phones}=lists();const a=street(c?.address);
 if(a&&addresses.some(x=>a===x||a.startsWith(x+' ')))return 'address';
 const p=digits(c?.phone);if(p.length===10&&phones.includes(p))return 'phone';return ''}
const message=kind=>kind==='address'?'That street address is Glow Lab’s own address, not the customer’s. Enter the address the order should ship to.':'That phone number is Glow Lab’s own number, not the customer’s. Enter the customer’s phone number.';
module.exports={match,message,street,configured:()=>lists().addresses.length+lists().phones.length>0};

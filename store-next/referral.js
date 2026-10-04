/* Keep a referral through navigation on this website for this browser session. */
'use strict';
(()=>{try{const params=new URLSearchParams(location.search);if(params.has('ref')){const code=params.get('ref');sessionStorage.removeItem('glow_customer_store');if(code&&code.length<=200&&!/[\x00-\x20\x7f]/.test(code))sessionStorage.setItem('glow_referral',code);else sessionStorage.removeItem('glow_referral')}}catch{/* Storage may be disabled by the visitor. */}})();

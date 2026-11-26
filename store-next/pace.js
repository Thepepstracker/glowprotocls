// Glow pace colors (Jonah, 23 Oct 2026; ladder extended 26 Nov 2026: "more colors to the color bar, like diamond and
// some other cool ones", and a colored circle in Management "telling us if we're on track for today, behind, or like
// we are now purple"). One place for the color ladder and the day/week color, used by Packing Check and Management.
//   Week target = what the week before made (never under $4,500). Day target = week target / 7.
//   Red under 75% of pace · Yellow 75–99% · Green on pace · Blue target · Gold 1.5× · Purple 2× · Rainbow 2.5× · Galaxy 3× · Diamond 4× (Jonah: "i want the rainbow to be diamond": Diamond is the top)
// A day in progress is judged against how much of a normal day's money has usually come in by this time of day
// (our own paid orders, last 28 days). Before a quarter of a normal day has come in, the color is yesterday's result.
(function(root){
 var WEEK_FLOOR=450000,WEEK_HISTORY={'2026-10-19':825227};
 var LADDER=[
  {k:'diamond',dot:'💎',name:'DIAMOND',mult:4,week:'Four times last week',day:'Diamond day: the very top'},
  {k:'galaxy',dot:'🌌',name:'GALAXY',mult:3,week:'Triple last week',day:'Out of this world'},
  {k:'rainbow',dot:'🌈',name:'RAINBOW',mult:2.5,week:'2.5× last week',day:'Rainbow day'},
  {k:'purple',dot:'🟣',name:'PURPLE',mult:2,week:'Double last week',day:'Record-day territory'},
  {k:'gold',dot:'🟨',name:'GOLD',mult:1.5,week:'Way past last week',day:'Big day'},
  {k:'blue',dot:'🔵',name:'BLUE',mult:1,week:'Beat last week',day:'Day target hit'}];
 // Highest first, each with the cents it starts at.
 function tiersFor(target,kind){return LADDER.map(function(x){return{k:x.k,dot:x.dot,name:x.name,say:kind==='day'?x.day:x.week,at:target*x.mult}})}
 // Lowest first: the marks a bar climbs through above the target (Blue, Gold, Purple, Rainbow, Galaxy, Diamond).
 function marks(target){return LADDER.slice().reverse().map(function(x){return{at:target*x.mult,dot:x.dot,name:x.name.charAt(0)+x.name.slice(1).toLowerCase()}})}
 var title=function(s){return s.charAt(0)+s.slice(1).toLowerCase()};
 function legend(target,money){return LADDER.slice().reverse().map(function(x){return title(x.name)+' '+(money?money(target*x.mult):x.mult+'×')}).join(' · ')}
 function etDay(t){return new Date(t*1000).toLocaleDateString('en-CA',{timeZone:'America/New_York'})}
 function etHM(t){var p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(t*1000)),h=0,m=0;p.forEach(function(x){if(x.type==='hour')h=Number(x.value)%24;if(x.type==='minute')m=Number(x.value)});return{h:h,m:m}}
 function paidOrder(o){return !!o&&o.is_test===false&&!o.legacy_import&&!o.comped&&(o.status==='paid'||o.status==='shipped')}
 function weekKeys(now,offset){var today=etDay(now),d=new Date(today+'T12:00:00Z'),dow=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-dow-7*(offset||0));var k=[];for(var i=0;i<7;i++){k.push(d.toISOString().slice(0,10));d.setUTCDate(d.getUTCDate()+1)}return{keys:k,dow:dow}}
 function sum(orders,keys){var n=0,c=0;orders.forEach(function(o){if(paidOrder(o)&&keys.indexOf(etDay(o.created||0))>=0){n+=o.total||0;c++}});return{cents:n,count:c}}
 function weekTotal(orders,now,offset){var k=weekKeys(now,offset).keys;return WEEK_HISTORY[k[0]]!=null?WEEK_HISTORY[k[0]]:sum(orders,k).cents}
 function targetFor(orders,now,offset){return Math.max(WEEK_FLOOR,weekTotal(orders,now,(offset||0)+1))}
 function above(cents,T){for(var i=0;i<T.length;i++)if(cents>=T[i].at)return T[i];return null}
 // Where the bar is: the next color up and how far along to it.
 function next(cents,target,floorMarks){var list=(floorMarks||[]).concat(marks(target)).filter(function(x){return x.at>0}).sort(function(a,b){return a.at-b.at});
  var nx=null,floor=0;list.forEach(function(x){if(x.at>cents&&!nx)nx=x;if(x.at<=cents&&x.at>floor)floor=x.at});
  return{next:nx,pct:nx?Math.max(3,Math.min(100,Math.round((cents-floor)*100/Math.max(1,nx.at-floor)))):100}}
 function week(orders,now){var w=weekKeys(now,0),cur=sum(orders,w.keys),target=targetFor(orders,now,0),T=tiersFor(target,'week'),t=above(cur.cents,T),pace=target*w.dow/7;
  if(!t){if(!w.dow){var lw=sum(orders,weekKeys(now,1).keys).cents;t=lw>=targetFor(orders,now,1)?{k:'green',dot:'🟢',name:'GREEN',say:'New week — last week beat the week before'}:{k:'yellow',dot:'🟡',name:'YELLOW',say:'New week — last week fell short'}}
   else{var r=cur.cents/pace;t=r>=1?{k:'green',dot:'🟢',name:'GREEN',say:'On pace'}:r>=.75?{k:'yellow',dot:'🟡',name:'YELLOW',say:'Slipping behind pace'}:{k:'red',dot:'🔴',name:'RED',say:'Behind pace'}}}
  var n=next(cur.cents,target,w.dow?[{at:pace*.75,dot:'🟡',name:'Yellow'},{at:pace,dot:'🟢',name:'Green'}]:[]);
  return{tier:t,cents:cur.cents,count:cur.count,target:target,pace:pace,next:n.next,pct:n.pct,keys:w.keys,dow:w.dow}}
 function dayShare(orders,now){var today=etDay(now),bins=[],tot=0,n=0,i;for(i=0;i<24;i++)bins.push(0);
  orders.forEach(function(o){if(paidOrder(o)&&o.created>=now-28*86400&&etDay(o.created)!==today){bins[etHM(o.created).h]+=o.total||0;tot+=o.total||0;n++}});
  var hm=etHM(now),f=0;if(n<20||!tot)return (hm.h*60+hm.m)/1440;for(i=0;i<hm.h;i++)f+=bins[i]/tot;return f+bins[hm.h]/tot*hm.m/60}
 function dayFinal(cents,target){var t=above(cents,tiersFor(target,'day'));if(t)return t;return cents>=target*.75?{k:'yellow',dot:'🟡',name:'YELLOW',say:'Just missed'}:{k:'red',dot:'🔴',name:'RED',say:'Missed'}}
 function day(orders,now){var today=etDay(now),target=Math.round(targetFor(orders,now,0)/7),td=sum(orders,[today]),y=new Date(today+'T12:00:00Z');y.setUTCDate(y.getUTCDate()-1);
  var yHit=sum(orders,[y.toISOString().slice(0,10)]).cents>=target,share=dayShare(orders,now),t=above(td.cents,tiersFor(target,'day'));
  if(!t){if(share<.25)t=yHit?{k:'green',dot:'🟢',name:'GREEN',say:'Early — yesterday hit the target'}:{k:'yellow',dot:'🟡',name:'YELLOW',say:'Early — yesterday missed the target'};
   else{var r=td.cents/(target*share);t=r>=1?{k:'green',dot:'🟢',name:'GREEN',say:'On pace for today'}:r>=.75?{k:'yellow',dot:'🟡',name:'YELLOW',say:'Slipping behind today’s pace'}:{k:'red',dot:'🔴',name:'RED',say:'Behind today’s pace'}}}
  var n=next(td.cents,target,[]);return{tier:t,cents:td.cents,count:td.count,target:target,share:share,next:n.next,pct:n.pct}}
 var api={WEEK_FLOOR:WEEK_FLOOR,WEEK_HISTORY:WEEK_HISTORY,LADDER:LADDER,tiersFor:tiersFor,marks:marks,legend:legend,etDay:etDay,paidOrder:paidOrder,weekKeys:weekKeys,sum:sum,targetFor:targetFor,week:week,day:day,dayFinal:dayFinal,dayShare:dayShare};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.GlowPace=api;
})(typeof window!=='undefined'?window:this);

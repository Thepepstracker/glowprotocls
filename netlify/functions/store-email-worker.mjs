// PAUSED 30 Oct 2026 (Jonah OK'd). The live store moved to Sevalla. This timed job must not run against the
// old Netlify database when it unlocks, or it could re-send old orders to ShipStation or email customers twice.
// No schedule is exported, so Netlify never runs it. To turn it back on, restore this file from commit 11bce36.
export default async()=>new Response('store-email-worker is paused: the store moved to Sevalla on 28 Oct 2026.',{status:200});


import React from 'react';
import CallsignChip from '../../shared/ui/CallsignChip';

interface ChangeLogViewProps {
    onBack: () => void;
}

// Deterministic, render-pure pseudo-random archive id derived from the (unique, stable) version string.
const archiveId = (version: string): string => {
    let hash = 0;
    for (let i = 0; i < version.length; i++) {
        hash = (Math.imul(31, hash) + version.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36).padStart(8, '0').slice(0, 8).toUpperCase();
};

const VersionCard: React.FC<{ version: string; title: string; children: React.ReactNode; isLatest?: boolean }> = ({ version, title, children, isLatest }) => (
    <section className={`bg-slate-900/80 backdrop-blur-md border rounded-xl p-5 sm:p-6 space-y-4 shadow-lg transition-all ${isLatest ? 'border-sky-500/50 shadow-sky-900/20' : 'border-slate-700/50 hover:border-slate-600'}`}>
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-white/5 pb-3">
            <div>
                <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">{`Version ${version}`}</h2>
                    {isLatest && <span className="bg-sky-500/20 text-sky-300 border border-sky-500/30 text-[10px] font-black px-2 py-0.5 rounded-sm uppercase tracking-widest">Current Release</span>}
                </div>
                <p className="text-[10px] text-sky-300 font-black uppercase tracking-widest mt-1">{title}</p>
            </div>
            <p className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">Archive ID: {archiveId(version)}</p>
        </div>
        <ul className="list-none space-y-3 text-slate-300 text-sm">
            {children}
        </ul>
    </section>
);

const ChangeLogView: React.FC<ChangeLogViewProps> = ({ onBack }) => {
    return (
        <div className="h-full flex flex-col overflow-hidden animate-fade-in">
            <div className="shrink-0 relative overflow-hidden border-b border-white/5 bg-linear-to-b from-sky-950/30 via-slate-950/80 to-slate-950">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-sky-500/10 rounded-full blur-[120px] pointer-events-none" aria-hidden />

                <div className="relative px-4 sm:px-8 pt-10 pb-8">
                    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
                        <div className="min-w-0">
                            <CallsignChip label="MODULE · CHANGELOG" icon="fa-scroll" accent="sky" />
                            <h1 className="mt-3 text-3xl sm:text-4xl font-black text-white tracking-tight leading-tight">
                                System Changelog
                            </h1>
                            <p className="mt-2 text-sm text-slate-400 max-w-2xl">
                                Operational updates and version history of the platform.
                            </p>
                        </div>
                        <div className="flex shrink-0">
                            <button
                                onClick={onBack}
                                className="flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase tracking-widest text-slate-300 bg-slate-900/60 border border-slate-700 rounded-lg hover:border-sky-500/40 hover:bg-sky-500/10 hover:text-sky-300 transition-colors"
                            >
                                <i className="fa-solid fa-arrow-left"></i> Back to Help
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto w-full space-y-6">

                <VersionCard version="15.7.0-open" title="Another Major Fast-Forward" isLatest>
                    <li><strong className="font-semibold text-slate-100">A big jump.</strong> The open build had fallen a long way behind the hosted platform again, and this release closes the whole gap in one step — six new modules, a long list of fixes, and a great deal of work on who can see what. Where the two builds disagreed, this one now does the safer thing; several of the changes here have no counterpart in the hosted version at all.</li>
                    <li><strong className="text-emerald-400">[New]</strong> <strong className="font-semibold text-slate-100">Blueprint Manager.</strong> A registry of what your members can make, and a crafting board on top of it. Register a blueprint, opt in to craft it for others, and anyone can raise a request against it — a crafter claims it, marks it ready and delivered, and the person who asked confirms they received it. Nobody can close that last step on their behalf, not even an admin: confirming receipt is the whole point of a two-sided handover. Offering to craft is always your own choice. Off by default; enable it in Admin → Optional Features.</li>
                    <li><strong className="text-emerald-400">[New]</strong> <strong className="font-semibold text-slate-100">Organisation bans, with appeals.</strong> A banned member is refused at login, at every read and at every write, and is shown why and for how long rather than a blank error. Appeals route to the people who can hear them, and a banned member can still reach their own notice and appeal form — nothing else.</li>
                    <li><strong className="text-emerald-400">[New]</strong> <strong className="font-semibold text-slate-100">Ship seats on operations.</strong> Define the seats a ship needs, let people apply, and assign them. Seat counts are enforced by the database, so two people cannot take the last seat at the same moment.</li>
                    <li><strong className="text-emerald-400">[New]</strong> <strong className="font-semibold text-slate-100">Academy 1.2.</strong> Members can ask for a place on a gated course instead of waiting to be noticed, and instructors get a queue with an approve/decline note. Modules, lessons and outcomes can be reordered — as one operation, so a reorder can never half-apply — and a course sent back for revision now carries a mandatory explanation the author can actually read. Four Learning-Manager reports read back the sign-off trail the module has always recorded and never showed you: completions, per-course activity, who holds a certification, and one member&apos;s full training record.</li>
                    <li><strong className="text-emerald-400">[New]</strong> <strong className="font-semibold text-slate-100">Marketplace: barter, and sellers who can manage their own listings.</strong> Listings and contracts can now ask for goods instead of money — or as well as it. Sellers can edit, pause, resume and close their own listings rather than deleting and starting again, with a new My Listings panel, and clicking a seller&apos;s name opens their trader profile.</li>
                    <li><strong className="text-emerald-400">[New]</strong> <strong className="font-semibold text-slate-100">The notification bell finally has things to say.</strong> Thirteen new alerts: being assigned to a request or named lead responder, being added to or removed from an operation, being given a task or a command role, having a finance entry approved or rejected, and having a course approved or sent back.</li>
                    <li><strong className="text-emerald-400">[New]</strong> <strong className="font-semibold text-slate-100">Armoury filtering that works on the whole catalogue.</strong> Filters now run in the database rather than over whatever happened to be on the current page, so a filtered count is the real count.</li>
                    <li><strong className="text-emerald-400">[New]</strong> <strong className="font-semibold text-slate-100">For whoever runs the server.</strong> You can change your encryption key now — it used to come with a warning never to touch it. API keys have a life cycle: limited to what they are for, expiring, and revoked in a way that keeps the record rather than deleting it. There is a proper <code className="text-slate-200">/healthz</code> address your hosting can watch, a new Security Audit tab showing refused attempts, and Database Tools now tells you if your database is behind the code.</li>
                    <li><strong className="text-sky-400">[Fix]</strong> <strong className="font-semibold text-slate-100">Updating no longer greets people with a red error screen.</strong> When you deployed an update, anyone with the app already open went looking for a file that no longer existed. The app had three separate ways to recover from that, and one old line of code was quietly stopping all three. That line is gone, and the app now notices a new version and offers a small prompt instead. It never reloads on its own, so nothing you are part-way through typing is lost.</li>
                    <li><strong className="text-sky-400">[Fix]</strong> <strong className="font-semibold text-slate-100">Things that were simply broken.</strong> Squad and mission voice channels could never be joined at all — the server rejected the exact channel names its own interface was creating. Operation reminders were written but never delivered. On a brand new install, Finances, Warehouse, the Armoury and the Academy were admin-only because the starting roles were never given permissions for them. Pasted YouTube links were deleted on save. All fixed.</li>
                    <li><strong className="text-sky-400">[Fix]</strong> <strong className="font-semibold text-slate-100">Long lists could quietly show you the wrong rows.</strong> When a list was capped at, say, the newest 200 entries, the database was never told precisely enough what &quot;newest&quot; meant — so where several rows shared a timestamp it could hand back any of them, and two people looking at the same screen could see different entries. Sixty places had this. The same fault could make an org import mismatch items in a large catalogue. All of them now specify an exact order.</li>
                    <li><strong className="text-sky-400">[Fix]</strong> <strong className="font-semibold text-slate-100">Everyday corrections.</strong> &quot;Set new total&quot; on a stock count now sends the number you typed and lets the server do the arithmetic, so two people correcting the same item cannot land it somewhere neither intended. Editing a wiki page can no longer take the whole dashboard down. Toggling maintenance mode no longer switches off your force-logout. And you get one notification for a new request, not two.</li>
                    <li><strong className="text-sky-400">[Polish]</strong> <strong className="font-semibold text-slate-100">Quicker, and more honest about numbers.</strong> Thirty new database indexes on the links between records, so the database stops re-reading whole tables to answer ordinary questions. Treasury totals are now calculated by the database rather than added up in the app, where a busy org could be shown a total quietly missing entries.</li>
                    <li><strong className="text-sky-400">[Security]</strong> <strong className="font-semibold text-slate-100">A substantial hardening pass, and then another one.</strong> Two rounds of work on who can see and do what. The headline changes: your clients are no longer handed your member roster, clearance levels or role list; a role&apos;s NAME no longer grants it authority, so a custom role is exactly as powerful as the permissions you actually gave it and nothing more; your sign-in no longer sits where a script on the page could read it; and restricted operations no longer post their full briefing to a general Discord channel. Beyond those, we further tightened the bolts on data minimisation — a long tail of small over-shares closed across HR, intel, the marketplace, government and operations, several places that failed in the wrong direction when the database hiccupped, and a set of rules the interface showed you but the server never actually enforced. None of it changes how the platform is used day to day.</li>
                    <li><strong className="font-semibold text-slate-100">For self-hosters.</strong> Re-running <code className="text-slate-200">schema.sql</code> is REQUIRED on this release, not optional — it adds new tables, new permissions, new database functions and thirty indexes, and narrows what the database hands out. It is safe to run more than once and will not touch your data, though creating indexes briefly locks the tables involved, so pick a quiet moment if your org is large. Then run Repair Database once from the admin console so the Member and Dispatcher roles receive the new permissions; anything you have deliberately revoked stays revoked.</li>
                </VersionCard>

                <div className="space-y-6">
                    <h3 className="text-xs font-black text-slate-500 uppercase tracking-[0.3em] flex items-center">
                        <span className="h-px bg-slate-700 grow mr-4"></span>
                        Version History
                        <span className="h-px bg-slate-700 grow ml-4"></span>
                    </h3>

                    <VersionCard version="15.4.1-open" title="The Catch-Up Update">
                        <li><strong className="font-semibold text-slate-100">A fast-forward for the open build.</strong> The open-source build had drifted a few versions behind the hosted one while these features were built and proven there. This release brings the two back into line in a single jump, so everything below has already been running on the hosted platform and is now yours to self-host.</li>
                        <li><strong className="text-sky-400">[New]</strong> <strong className="font-semibold text-slate-100">A proper notifications inbox.</strong> The bell in the top bar now keeps a running history of the things that concern you, such as a service request you raised moving forward, being handed a recruitment case, or gear being issued to you. Instead of a single message that flashes once and is gone, it fills in as you go and tidies itself up over time.</li>
                        <li><strong className="text-sky-400">[New]</strong> <strong className="font-semibold text-slate-100">An Academy.</strong> A full training module: build courses and lessons, run sessions with rosters, enrol your members, and award certifications on completion. It is an optional feature and ships turned off. Switch it on under Admin, Optional Features, when you want it.</li>
                        <li><strong className="text-sky-400">[New]</strong> <strong className="font-semibold text-slate-100">Upload images directly.</strong> Anywhere the app used to ask for an image link, you can now upload a picture straight from your device instead. That covers org branding, ranks, units, awards, quartermaster items, wiki and government pages, and more. Uploads are re-encoded and stored on your own Supabase project, and images on private pages stay private, handed out only to people allowed to see them.</li>
                        <li><strong className="text-sky-400">[New]</strong> <strong className="font-semibold text-slate-100">Your own accent colour.</strong> You can set an org accent colour under Admin, Appearance, and the interface re-tints to match. Optional and off by default.</li>
                        <li><strong className="text-sky-400">[Polish]</strong> <strong className="font-semibold text-slate-100">A tidy-up of the interface.</strong> The admin appearance settings now sit behind one tab, duty-roster rows click straight through to a member's service record, HR case management swapped its row of tabs for a cleaner dropdown, and a few settings screens were reorganised into clearer sections.</li>
                        <li><strong className="text-sky-400">[Security]</strong> <strong className="font-semibold text-slate-100">Optional features now truly turn off.</strong> When you disable an optional module, whether that is the marketplace, warehouse, finances, quartermaster, government, or the new Academy, the server now refuses it outright, not just the menu that leads to it. Before, "off" only hid the navigation while the underlying actions could still be reached by anyone whose role allowed them. This closes that gap. It is invisible in normal use, and tests were added to keep it that way.</li>
                        <li><strong className="font-semibold text-slate-100">For self-hosters.</strong> This release adds new tables, a couple of new permissions, and two image-storage buckets, so re-run schema.sql in your Supabase SQL editor after updating. It is idempotent, so it is safe to run more than once. Then use Repair Database, under Admin, Database Tools, so your Admin role picks up the new permissions. The Academy and the custom accent colour are optional and ship turned off; enable them under Admin when you want them. Image uploads work out of the box; per-file and total size limits can be set with environment variables if you want to cap them.</li>
                    </VersionCard>

                    <VersionCard version="15.2.1-open" title="Dependencies & Hardening">
                        <li><strong className="text-sky-400">[Fix]</strong> <strong className="font-semibold text-slate-100">15.2.1 patch - database connectivity.</strong> A follow-up to the library refresh below. The updated networking library changed how the server opens its outbound connections, which in some setups stopped it from reaching its database on startup. This patch lines the two back up so the connection is made cleanly again. It is a code-only change, with no effect on your data or on how the app is used day to day.</li>
                        <li><strong className="text-sky-400">[Maintenance]</strong> <strong className="font-semibold text-slate-100">Fresh foundations.</strong> I updated the underlying libraries the platform is built on to their current, best-supported versions, and reworked the parts of the code that needed it so everything fits the newer versions cleanly. None of this changes what you see or do day to day. It keeps the foundation current and secure, and makes the project easier to look after going forward.</li>
                        <li><strong className="text-sky-400">[Security]</strong> <strong className="font-semibold text-slate-100">Another security pass, layer by layer.</strong> I went back through the platform once more as a defence-in-depth review and tightened a broad set of access, validation, and data-handling checks. As with the passes before it, almost none of this is visible in everyday use. The point is simply that information and actions stay with the people they are meant for. Tests were added to keep it that way.</li>
                        <li><strong className="font-semibold text-slate-100">For self-hosters.</strong> This release touches the database. After updating, re-run schema.sql in your Supabase SQL editor to pick up the changes. It is idempotent, so it is safe to run more than once.</li>
                    </VersionCard>

                    <VersionCard version="15.1.5-open" title="Privacy & Access Hardening">
                        <li><strong className="text-sky-400">[Security]</strong> <strong className="font-semibold text-slate-100">This one was about privacy and keeping authority where it belongs.</strong> A restricted unit's voice room is now as private as its text channel, so only its members can drop in and listen. Added additional verification backstop before RSI handle is stamped as verified. Running the government can no longer be turned into a way to quietly hand yourself one of the top seats, only an admin can fill those. Nothing looks different in daily use, and I wired in tests to keep it that way.</li>
                        <li><strong className="text-sky-400">[Security]</strong> <strong className="font-semibold text-slate-100">Tighter internal data handling.</strong> I brought the data layer in line with the hosted version. Every database read now asks for exactly the fields it needs instead of pulling whole rows. This is the gate and scope work done for the hosted version, and in this case is defence in depth downstream. This ensures that a column added to the database later can't quietly flow somewhere it should not.</li>
                        <li><strong className="font-semibold text-slate-100">Application spam is capped.</strong> Recruitment and job applications now have a sensible per-person limit, the same job can't be applied to twice, and a flood of them can no longer bury the HR team in notifications.</li>
                        <li><strong className="font-semibold text-slate-100">For self-hosters.</strong> There are database changes in this release, so re-run schema.sql in your Supabase SQL editor once you have updated. It is safe to run more than once.</li>
                    </VersionCard>

                    <VersionCard version="15.1.4-open" title="Security Hardening">
                        <li><strong className="text-sky-400">[Security]</strong> <strong className="font-semibold text-slate-100">Another security pass, and a review that went looking for ways to break in.</strong> A few things came up and I fixed them. A partnered org can no longer take over a joint operation you are sharing with them. The RSI handle check can no longer be fooled into linking a handle you do not own. Starting or cancelling a service request now stays with the people actually on it. And a sign-in now stays valid for about a day instead of a week, so a stolen session stops working much sooner. None of this changes how the app works from day to day. I added tests so it stays that way.</li>
                        <li><strong className="font-semibold text-slate-100">Safer if you do not run a proxy.</strong> Rate limiting and abuse blocking used to assume there was a reverse proxy sitting in front of the app. They now work correctly on their own, so a plain setup is protected with no extra config. If you do put a proxy in front, set TRUST_PROXY_HOPS to how many there are so the app sees each visitor's real address.</li>
                        <li><strong className="font-semibold text-slate-100">For self-hosters.</strong> This one touches the database. After updating, re-run schema.sql in your Supabase SQL editor. Running it again is safe.</li>
                    </VersionCard>

                    <VersionCard version="15.1.3-open" title="Access Hardening">
                        <li><strong className="text-sky-400">[Security]</strong> <strong className="font-semibold text-slate-100">A small round of hardening.</strong> I brought a handful of improvements across from the hosted version. The main one: when an admin revokes someone's sessions or removes their account, that now takes effect right away for reading data too, not just for making changes. Around it are some quieter safeguards: a person's clearance can only be changed through the proper, logged path; an extra safety net keeps any future secret setting from ever reaching the browser; and a few list and search queries were tidied up. It is all invisible day to day; the point is that access stays with the people it is meant for. Tests were added to keep it that way.</li>
                        <li><strong className="font-semibold text-slate-100">For self-hosters.</strong> This is a code-only update. There are no database changes, so you do not need to re-run schema.sql for this update.</li>
                    </VersionCard>

                    <VersionCard version="15.1.2-open" title="Sign-In Fix">
                        <li><strong className="text-sky-400">[Fix]</strong> <strong className="font-semibold text-slate-100">Discord sign-in fix.</strong> The hardening in 15.1.1 added a server-side safety check to the sign-in handshake, but the app was handing that handshake back in a slightly different shape than the check expected, so it could turn people away when they tried to log in with Discord. This release lines the two halves back up, so sign-in completes normally again with the new protection still fully in place, and adds a test so the two can't quietly drift apart again. Thanks to witherfork from the community for spotting and providing a fix.</li>
                        <li><strong className="font-semibold text-slate-100">For self-hosters.</strong> This one is a code-only fix. There are no database changes, so you do not need to re-run schema.sql for this update.</li>
                    </VersionCard>

                    <VersionCard version="15.1.1-open" title="Hardening Pass">
                        <li><strong className="text-sky-400">[Security]</strong> <strong className="font-semibold text-slate-100">Another round of hardening.</strong> I worked back through the platform and tightened a wide range of access and validation checks across operations, intel, the marketplace, alliance sharing, and sign-in and session handling. This closed a number of edge cases found in a deep review. Almost all of it is invisible day to day; the point is that data and actions stay with the people they are meant for. Tests were added to keep it that way. These reflect improvements made in the hosted version of myrsi.org since the release of 15.1.0-open</li>
                        <li><strong className="font-semibold text-slate-100">For self-hosters.</strong> This update adds a few database columns and helper functions. After updating, re-run schema.sql in your Supabase SQL editor to pick them up. It is idempotent, so it is safe to run.</li>
                    </VersionCard>

                    <VersionCard version="15.1.0-open" title="Marketplace + Hardening">
                        <li><strong className="text-sky-400">[Marketplace]</strong> <strong className="font-semibold text-slate-100">Restored Marketplace feature with new chrome.</strong> This one speaks for itself. The marketplace is back and looking a fair bit better.</li>
                        <li><strong className="text-sky-400">[Security]</strong> <strong className="font-semibold text-slate-100">Another security pass.</strong> I went back through the platform again and tightened the checks on who can see what across operations, intelligence, HR, the marketplace, and alliance sharing. Most of this is invisible day to day, which is the point: information only ever reaches the people it is meant to. Appropriate tests have been wired in.</li>
                        <li><strong className="font-semibold text-slate-100">Operation templates now respect clearance.</strong> A template saved from a classified operation now inherits that operation's clearance, so its plan can only be seen and reused by people cleared for it, not everyone in the org.</li>
                    </VersionCard>

                    <VersionCard version="15.0.0-open" title="The Open-Source Release">
                        <li><strong className="text-green-400">[Release]</strong> <strong className="font-semibold text-slate-100">Open-Source, Self-Hosted Build</strong>: MyRSI.org is now available as a self-hostable build under a source-available, noncommercial licence. One deployment runs one organisation. Bring your own Supabase project and Discord application, drop in your environment config, and a polished first-run setup wizard walks you from a preflight environment check through Discord sign-in, the one-time admin claim code, RSI handle verification, and an optional import of your existing data. The first Discord login that redeems the console setup code becomes Admin.</li>
                        <li><strong className="font-semibold text-slate-100">A personal note.</strong> This release is my soft close on MyRSI. It is not the final update and I am not disappearing, but it marks the point where I step back from the day to day. I wanted to leave the platform in the best and safest state I could, and to make sure none of you are ever locked in. Here is what that looks like.</li>
                        <li><strong className="font-semibold text-slate-100">Warrants are now Caution Notes.</strong> Same feature, friendlier name. It flags people your organisation should be wary of and shows a clear warning on any service request that involves them. The old labels are gone, replaced with three simple levels: Caution, High Caution, and Extreme Caution.</li>
                        <li><strong className="font-semibold text-slate-100">Security and privacy came first.</strong> After the security incident some of you saw earlier, I went back through the entire platform from top to bottom reviewing any point at which data is transacted. This was the single biggest part of the release.</li>
                        <li><strong className="font-semibold text-slate-100">MyRSI is now open source.</strong> The platform is free and open for anyone to read, run, and build on. The full source for the self hosted version lives at <a href="https://github.com/MyRSI-org/open-myrsi-org" target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:text-sky-200 underline">github.com/MyRSI-org/open-myrsi-org</a>. If you ever want to host your own copy or just see how everything works under the hood, it is all there. Your org owner can export your full organisation's data from the billing portal at any time to take it with you.</li>
                        <li><strong className="font-semibold text-slate-100">Reliability and tidy up.</strong> I fixed a range of behind the scenes issues that could trip up sign in or pages, made the app much clearer when something goes wrong, and removed a few older tools that were no longer needed.</li>
                        <li><strong className="font-semibold text-slate-100">Thank you.</strong> Trusting me with your organisations has genuinely meant a lot. The lights stay on, the code is yours, and I am still around. Fly safe.</li>
                    </VersionCard>

                    <VersionCard version="14.8.0-hosted" title="The Operations & Performance Update">
                        <li><strong className="text-slate-300">In short:</strong> Added cost and payout tracking to operations, the option to send each type of service request to its own Discord channel, a live level meter for the radio, and a cleaner career timeline, along with faster loading and a range of polish and reliability fixes.</li>
                    </VersionCard>

                </div>

                {/* ATTRIBUTION CARD - May not be modified under licence and attribution terms*/}
                <div className="bg-slate-900/80 backdrop-blur-md border border-slate-700/50 rounded-xl p-6 sm:p-8 flex flex-col items-center text-center space-y-4">
                    <div className="w-16 h-16 bg-sky-500/10 rounded-lg flex items-center justify-center border border-sky-500/30">
                        <i className="fa-solid fa-code text-2xl text-sky-300"></i>
                    </div>
                    <div>
                        <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest">Application Attribution</p>
                        <h3 className="text-xl font-black text-white mt-1 tracking-tight">Built by <span className="text-sky-300">Jenk0</span></h3>
                        <p className="text-slate-500 text-[10px] font-black uppercase tracking-widest">Referral Code: <a href="https://www.robertsspaceindustries.com/enlist?referral=STAR-2GNM-TTHD">STAR-2GNM-TTHD</a></p>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-slate-500 font-mono uppercase tracking-widest pt-3 border-t border-white/5 w-full justify-center">
                        <span>STC-2955 Compliance Confirmed</span>
                        <span className="text-slate-700">·</span>
                        <span><a href="https://github.com/MyRSI-org/open-myrsi-org" target="_blank" rel="noopener noreferrer">Source Available</a> · Noncommercial (with attribution)</span>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default ChangeLogView;

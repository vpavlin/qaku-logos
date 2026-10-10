# Demo script: QAKU in 5 minutes

For showing QAKU to someone who runs talks, meetups or town halls. One laptop with Basecamp
(you, the host, ideally on the projector) and one or more Android phones (the audience: yours,
plus anyone in the room who wants to join in). You create a fresh Q&A on the spot, so there is
nothing to prepare beyond installing.

## Before (10 minutes, once)

**Laptop:** Basecamp 0.3. Add the package repository `https://apps.vpavlin.xyz/logos-repo.json`
and install **QAKU - Q&A** (its engine, `qaku_core`, and Loam's `loam_core` come along).

**Phone:** add the F-Droid repo from [apps.vpavlin.xyz](https://apps.vpavlin.xyz) and install
**QAKU**. Installing **Loam** too is recommended: QAKU uses it when it's there (open Loam once,
leave it running, and approve QAKU in Loam when asked), and then each Q&A gets its own identity.
Without Loam, QAKU runs its own built-in node and works the same on stage.

**Set a name on each device**, so the audience sees people, not addresses. Phone: tap the name
pill top right → *Your display name* → *Save*. Laptop: the *DISPLAY NAME* box in the sidebar → *Save*.

Do a dry run: create a throwaway Q&A on the laptop, join it from the phone, ask one question,
check it shows up on the laptop. Then you know the network is reachable from the venue.

## The demo

**1. Create the Q&A (laptop, 30 s).** In the sidebar click **+ New Q&A**, type a title
("Town Hall"), optionally a description, click **Create**.
- The header shows the title and *Open*. "That's it. No sign-up, no server to rent."

**2. Let the room in (laptop + phones, 1 min).** Click **Share** in the header.
- A QR code appears with *Share link* and *Secret (password)*.
- On the phone: QAKU home → **Scan** → point at the QR. The Q&A opens.
- *Say:* the secret is the password. Everything is encrypted with it; only people in the room can read it.

**3. Ask and upvote from the phones (1 min).** On the phone, type in *Ask a question…* → **Ask**.
- It appears on the laptop within seconds, with the asker's name. Have a second person ask too.
- Tap **▲** on a question on the phone. On the laptop, with *Sort: Top*, it climbs.
- *Say:* this is the moment. The phones and the laptop talk to each other directly; there is no
  QAKU server in the middle.
- On the phone, point at the small **✓** next to a name: every question is signed, so nobody can
  post as someone else.

**4. Answer and moderate (laptop, 1 min).** You're the host, so you get extra links under each question.
- **Answer** → *Write an answer...* → **Post**. Then **accept ✓** on it: the question gets a teal
  border and the phone shows it as answered.
- **Hide** an off-topic question. It moves into *Hidden (1)* at the bottom, for everyone.
- *Show: Unanswered* is the "what's left" view for the end of a session.

**5. A quick poll (laptop, 1 min).** Click the **Polls** tab → **▸ New poll**.
- Question "Which topic next?", two or three options, *Results*: **Always**, then **Create poll**.
- Phones: tap **Polls** → tap an option. The bars move on the laptop.
- *Say:* it shows counts only, never who voted for what.

**6. Wrap up (laptop, 30 s).** Click **Close** in the header: phones show *This Q&A is closed*
and can't ask anymore. Everything is still there to read; **Open** turns it back on.

Optional extras, if you have time:
- **Bring in a co-host:** in the Share card, *Invite a moderator* → **New link** → send it. Whoever opens it first can answer and moderate too. (On the phone: *Admins* → *Invite a moderator*.)
- **On stage with a stream (desktop only):** *STREAM OVERLAY* in the sidebar, then **+ STREAM** on a question puts it into an OBS browser source.
- **Keep it alive on the phone (phone only):** the **☆** in the room header keeps a Q&A syncing in the background and notifies on new questions.

## If something goes wrong

- **The phone shows nothing after scanning:** give it a minute; pull down to refresh. The line
  at the bottom of the screen shows the peer count; "forming…" means it's still connecting.
- **QAKU on the phone mentions Loam:** open Loam, make sure it's running and QAKU is approved there.
- **A question shows "⏳ queued":** it's saved on the device and is retried until it reaches the
  network. Nothing is lost; it shows up on the other screens once it gets through.
- **Can't scan (no camera permission, bad light):** *Copy link* on the laptop, send it to the
  phone, paste it into *Join: secret / qaku://join link* → **Join**.

## What to leave them with

- Ask, upvote, answer, moderate, poll: everything a Q&A needs, on a laptop and on phones.
- No server, no accounts. The Q&A lives on the devices of the people in it, encrypted, and every
  question is signed by whoever asked it.
- Install from [apps.vpavlin.xyz](https://apps.vpavlin.xyz).

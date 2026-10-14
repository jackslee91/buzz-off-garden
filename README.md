# Buzz Off Garden – live class version

This folder runs the game AND the live class rooms (pupils see each other, teacher monitor).
Vercel cannot keep live connections open, so use Render (free) instead. One link does everything.

## Put it online (about 10 minutes)
1. Make a free account at github.com. Click New repository (name: buzz-off-garden, Public or Private).
2. On the new repository page click "uploading an existing file". Drag in EVERYTHING from this folder
   (server.js, package.json, render.yaml, .gitignore and the whole "public" folder). Click Commit changes.
3. Make a free account at render.com (sign in with GitHub). Click New > Web Service > pick buzz-off-garden.
   - Runtime: Node
   - Build Command: npm install
   - Start Command: npm start
   - Instance Type: Free
   - Environment Variables > Add: TEACHER_PIN = (a secret PIN only you know, e.g. 7391)
4. Click Create Web Service. After a few minutes you get a link like https://buzz-off-garden.onrender.com
5. Put that link in Google Classroom for pupils.

## For the teacher
Open the link with ?teacher on the end, e.g. https://buzz-off-garden.onrender.com/?teacher
Tick "I am the teacher", type your PIN, type the class code, press Start. Pupils never see this box.
Wrong PIN = you join as a pupil.

## Good to know
- Free Render sleeps after 15 minutes without visitors. The first visit then takes up to a minute.
  Open the link yourself 5 minutes before the lesson to wake it up.
- Each class code is its own room (up to 120 pupils per room). Pupils type small letters and numbers only.
- Nothing is stored on the server. Names and positions disappear when pupils leave.
- To change the PIN: Render > your service > Environment.

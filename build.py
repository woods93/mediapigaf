#!/usr/bin/env python3
"""
Build the Media Pig AF static site.

    python3 build.py   -> writes index.html, about.html, contact.html

Edit the text here, rebuild, commit, push. GitHub Pages serves the result.
"""
import html

NAME = "Media Pig AF"
TAGLINE = "Music Production • Artist Development • Sync & Licensing"
# Contact form: Web3Forms access key (public by design). Leave "" until the key exists.
WEB3FORMS_KEY = ""
# Public email, assembled in the browser so it is not in the page source. Leave both "" to hide.
EMAIL_USER, EMAIL_DOMAIN = "", ""
# Logo file in img/ (used if present; otherwise the name is set as text).
LOGO = "img/logo.png"

SERVICES = [
    ("Music production", "Quality recording and production, start to finish, with the care a record deserves."),
    ("Artist development", "Working with independent artists on songs, sound, and the long game."),
    ("Live performance recording", "Capturing performances as they happen, in the room, with the energy intact."),
    ("Original media", "Original music, performances, and stories made and shared under our own name."),
    ("Sync licensing representation", "Placing finished recordings in film, TV, and media, so music gets more than one chance to be heard."),
]


def esc(s):
    return html.escape(s, quote=True)


NAV = [("index.html", "Home"), ("about.html", "About"), ("contact.html", "Contact")]


def page(filename, title, description, body):
    import os
    items = "".join(
        f'<li><a href="{h}"{" aria-current=\"page\"" if h == filename else ""}>{l}</a></li>' for h, l in NAV)
    mark = (f'<img src="{LOGO}" alt="{esc(NAME)}" height="64">' if os.path.exists(LOGO)
            else f'<span class="wordmark">Media Pig <b>AF</b></span>')
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(description)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="icon" href="img/favicon.png" type="image/png">
<link rel="stylesheet" href="css/style.css?v=3">
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
  <a class="logo" href="index.html" aria-label="{esc(NAME)} home">{mark}</a>
  <nav aria-label="Main"><ul>{items}</ul></nav>
</header>
<main id="content">
{body}
</main>
<footer class="foot">
  <p>Founded in Nashville, Tennessee &copy; 2026 {esc(NAME)}</p>
</footer>
<script src="js/site.js"></script>
</body>
</html>
"""


def build_index():
    cards = "".join(f'<li><h3>{esc(t)}</h3><p>{esc(d)}</p></li>' for t, d in SERVICES)
    return f"""<section class="hero">
  <div class="hero-text">
  <p class="kicker">Nashville, Tennessee</p>
  <h1>{esc(NAME)}</h1>
  <p class="tag">{esc(TAGLINE)}</p>
  <p class="lede">An independent music production and artist development company. We make original recordings, develop artists, and give finished work a longer life.</p>
  <p><a class="btn" href="contact.html">Get in touch</a> <a class="btn ghost" href="about.html">About us</a></p>
  </div>
  <img class="hero-art" src="img/logo.png" alt="A pig leaning on a guitar amp, the Media Pig AF logo" width="320">
</section>
<section class="band">
  <h2>What we do</h2>
  <ul class="cards">{cards}</ul>
</section>
<section class="band narrow">
  <h2>Our aim</h2>
  <p>To create meaningful work, support independent artists, and give music more than one chance to be heard.</p>
</section>"""


def build_about():
    return f"""<section class="page">
  <h1>About {esc(NAME)}</h1>
  <p>{esc(NAME)} is an independent music production and artist development company based in Nashville, Tennessee. It creates original recordings, develops artists, and connects finished work with new opportunities.</p>
  <p>The company was founded on decades of experience in music production and collaboration, and it holds to authenticity, artistic independence, and quality.</p>
  <p>The goal is to help independent artists extend the creative and commercial life of their recordings beyond a single release cycle.</p>
  <h2>Services</h2>
  <ul class="plain">{"".join(f"<li>{esc(t)}</li>" for t, _ in SERVICES)}</ul>
</section>"""


def build_contact():
    mail = ""
    if EMAIL_USER and EMAIL_DOMAIN:
        mail = f'<p>Email: <a class="mail" data-u="{esc(EMAIL_USER)}" data-d="{esc(EMAIL_DOMAIN)}" href="contact.html">(enable JavaScript to see the address)</a></p>'
    return f"""<section class="page">
  <h1>Contact us</h1>
  <p>Questions about production, artist development, or licensing? Send a message.</p>
  {mail}
  <form id="contact-form" action="https://api.web3forms.com/submit" method="POST" data-key="{esc(WEB3FORMS_KEY)}">
    <input type="hidden" name="access_key" value="{esc(WEB3FORMS_KEY)}">
    <input type="hidden" name="subject" value="New message from the {esc(NAME)} website">
    <input type="hidden" name="from_name" value="{esc(NAME)} website">
    <input type="checkbox" name="botcheck" class="hp" tabindex="-1" autocomplete="off" style="display:none">
    <div class="row">
      <label>First name<input name="first_name" required autocomplete="given-name"></label>
      <label>Last name<input name="last_name" autocomplete="family-name"></label>
    </div>
    <label>Email<input type="email" name="email" required autocomplete="email"></label>
    <label>Write a message<textarea name="message" rows="6" required></textarea></label>
    <button class="btn" type="submit">Send</button>
    <p class="form-status" role="status" aria-live="polite"></p>
  </form>
</section>"""


PAGES = [
    ("index.html", f"{NAME} | Music Production, Artist Development, Sync & Licensing",
     "Independent music production, artist development, and sync licensing in Nashville, Tennessee.", build_index),
    ("about.html", f"About | {NAME}",
     "About Media Pig AF, an independent music production and artist development company in Nashville.", build_about),
    ("contact.html", f"Contact | {NAME}", "Contact Media Pig AF.", build_contact),
]

if __name__ == "__main__":
    for fn, title, desc, fn_body in PAGES:
        open(fn, "w", encoding="utf-8").write(page(fn, title, desc, fn_body()))
        print("wrote", fn)

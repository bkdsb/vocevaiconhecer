#!/usr/bin/env python3
import json
import re
from urllib.parse import urljoin, urlparse

SOURCES = [
    ("Fatos Sobrenaturais", "https://www.facebook.com/FatoSobrenaturais", "curiosity", "facebook"),
    ("Desconhecidos Fatos", "https://www.facebook.com/Desconhecidos.Fatos", "curiosity", "facebook"),
    ("Fábrica de Inspirações", "https://www.facebook.com/fabricadeinspiracoes", "curiosity", "facebook"),
    ("Jeito Nordestino", "https://www.facebook.com/0JeitoNordestino", "curiosity", "facebook"),
    ("Facebook 61552628161732", "https://www.facebook.com/profile.php?id=61552628161732", "curiosity", "facebook"),
    ("BBC News", "https://www.bbc.com/news", "news", "web"),
    ("BBC Science Focus", "https://www.sciencefocus.com/news", "curiosity", "web"),
    ("Revista Galileu", "https://revistagalileu.globo.com/", "curiosity", "web"),
    ("G1", "https://g1.globo.com/", "news", "web"),
    ("Live Science", "https://www.livescience.com/", "curiosity", "web"),
    ("National Geographic", "https://www.nationalgeographic.com/", "curiosity", "web"),
]

def clean(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()

def usable(text):
    if len(text) < 24 or len(text) > 240:
        return False
    lowered = text.lower()
    banned = ("log in", "sign up", "entrar", "cadastre", "cookies", "privacy", "terms", "menu")
    return not any(word in lowered for word in banned)

def fetch_page(url, kind):
    from scrapling.fetchers import Fetcher
    if kind == "facebook":
        try:
            from scrapling.fetchers import StealthyFetcher
            return StealthyFetcher.fetch(url, headless=True, locale="pt-BR", timezone_id="America/Sao_Paulo")
        except Exception:
            pass
    return Fetcher.get(url, impersonate="chrome", stealthy_headers=True)

def profile_source(name, url, category, kind):
    page = fetch_page(url, kind)
    texts = []
    for value in page.css("h1::text,h2::text,h3::text,a::text").getall():
        value = clean(value)
        if usable(value) and value not in texts:
            texts.append(value)
        if len(texts) >= 40:
            break
    if kind == "facebook" and len(texts) < 4:
        for value in page.css("body *::text").getall():
            value = clean(value)
            if usable(value) and value not in texts:
                texts.append(value)
            if len(texts) >= 40:
                break
    return {
        "source": name,
        "url": url,
        "category": category,
        "kind": kind,
        "status": int(page.status or 0),
        "topics": texts[:40],
    }

def main():
    profiles = []
    warnings = []
    for source in SOURCES:
        try:
            profile = profile_source(*source)
            if profile["topics"]:
                profiles.append(profile)
            else:
                warnings.append({"source": source[0], "code": "NO_PUBLIC_TOPICS"})
        except Exception as exc:
            warnings.append({"source": source[0], "code": type(exc).__name__})
    print(json.dumps({"profiles": profiles, "warnings": warnings}, ensure_ascii=False))

if __name__ == "__main__":
    main()

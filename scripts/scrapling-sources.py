#!/usr/bin/env python3
import json
import re
from urllib.parse import urljoin, urlparse

def parse_number(num_str):
    num_str = num_str.lower().replace(',', '.').strip()
    multiplier = 1
    if 'k' in num_str or 'mil' in num_str: multiplier = 1000
    elif 'm' in num_str or 'mi' in num_str: multiplier = 1000000
    num_str = re.sub(r'[^0-9\.]', '', num_str)
    try: return int(float(num_str) * multiplier)
    except: return 0


SOURCES = [
    ("Fatos Sobrenaturais", "https://www.facebook.com/FatoSobrenaturais", "curiosity", "facebook"),
    ("Desconhecidos Fatos", "https://www.facebook.com/Desconhecidos.Fatos", "curiosity", "facebook"),
    ("Fábrica de Inspirações", "https://www.facebook.com/fabricadeinspiracoes", "curiosity", "facebook"),
    ("Jeito Nordestino", "https://www.facebook.com/0JeitoNordestino", "curiosity", "facebook"),
    ("Oito Mundos", "https://www.facebook.com/profile.php?id=61552628161732", "curiosity", "facebook"),
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
    if any(word in lowered for word in banned):
        return False
    if re.search(r"recomendado por|avaliações|criador\(a\)|responsável por essa página|status online|compartilhado com|site de notícias e mídia|\b(seguidores|seguindo|curtidas|comentários|compartilhamentos)\b", lowered):
        return False
    # Logged-out Facebook pages expose bootloader JSON alongside visible text.
    # These payloads and bare domains are not editorial inspiration.
    if text.startswith(("{", "[", "//", "/*")) or re.search(r"(?:__d\(|require\(|function\s*\(|=>|<script|</?\w+>)", text):
        return False
    if re.fullmatch(r"(?:https?://|www\.)?[^\s]+\.[a-z]{2,}(?:/\S*)?", text, re.I):
        return False
    return True

def extract_topics(page, kind):
    if kind == "facebook":
        topics = []
        for node in page.css('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]'):
            value = clean(node.get_all_text(separator=" ", strip=True))
            value = re.sub(r"\s*(?:Ver mais|See more)\s*$", "", value, flags=re.I).strip()
            if len(value) > 240:
                value = value[:237].rsplit(" ", 1)[0] + "…"
            
            if usable(value) and not any(t.get("text") == value for t in topics):
                score = 0
                views = 0
                likes = 0
                comments = 0
                try:
                    parent = node.xpath('ancestor::div[@role="article" or @data-ad-comet-preview="message" or contains(@class, "x1yztbdb")][1]')
                    if parent:
                        full_text = parent[0].get_all_text(separator=" ", strip=True).lower()
                        likes_match = re.search(r"([0-9]+[\.,]?[0-9]*[km]?|\b[0-9]+)\s*(curtidas?|likes?)", full_text)
                        if likes_match: likes = parse_number(likes_match.group(1))
                        comments_match = re.search(r"([0-9]+[\.,]?[0-9]*[km]?|\b[0-9]+)\s*(comentários?|comments?)", full_text)
                        if comments_match: comments = parse_number(comments_match.group(1))
                        views_match = re.search(r"([0-9]+[\.,]?[0-9]*[km]?|\b[0-9]+)\s*(visualizações|views?)", full_text)
                        if views_match: views = parse_number(views_match.group(1))
                except Exception:
                    pass
                
                base_score = 10000 - (len(topics) * 500)
                score = base_score + likes + (comments * 2) + (views * 3)
                topics.append({"text": value, "metrics": {"likes": likes, "comments": comments, "views": views, "score": score}})
        
        topics = sorted(topics, key=lambda x: x["metrics"]["score"], reverse=True)
        return topics[:40]
    
    texts = []
    selectors = ["//*[self::h1 or self::h2 or self::h3 or self::a]//text()[not(ancestor::script or ancestor::style or ancestor::noscript or ancestor::template)]"]
    for selector in selectors:
        if texts and len(texts) >= 4: break
        for value in page.xpath(selector).getall():
            value = clean(value)
            if usable(value) and not any(t.get("text") == value for t in texts):
                base_score = 5000 - (len(texts) * 100)
                texts.append({"text": value, "metrics": {"likes": 0, "comments": 0, "views": 0, "score": base_score}})
            if len(texts) >= 40: break
    return texts[:40]

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
    texts = extract_topics(page, kind)
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

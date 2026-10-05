#!/usr/bin/env python3
import json
import re
import math
import os
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from urllib.parse import urljoin, urlparse, parse_qs, urlencode

def parse_number(num_str):
    value = str(num_str).lower().strip()
    suffix = re.search(r'(mil|mi|k|m)\s*$', value)
    multiplier = 1000 if suffix and suffix.group(1) in ('mil', 'k') else 1000000 if suffix else 1
    number = re.sub(r'[^0-9.,]', '', value)
    if suffix:
        number = number.replace(',', '.')
    else:
        number = re.sub(r'[.,](?=\d{3}(?:[.,]|$))', '', number).replace(',', '.')
    try: return max(0, int(float(number) * multiplier))
    except (ValueError, OverflowError): return None

def post_url(value):
    url = urljoin('https://www.facebook.com/', value or '')
    parsed = urlparse(url)
    if parsed.hostname not in ('facebook.com', 'www.facebook.com', 'm.facebook.com'):
        return None
    query = parse_qs(parsed.query)
    if 'comment_id' in query or 'reply_comment_id' in query:
        return None
    if re.search(r'/(posts|videos|reel)/[^/]+', parsed.path):
        return f'https://www.facebook.com{parsed.path}'
    allowed = {k: query[k][0] for k in ('story_fbid', 'id', 'fbid') if k in query}
    if 'story_fbid' in allowed or 'fbid' in allowed:
        return f'https://www.facebook.com{parsed.path}?{urlencode(allowed)}'
    return None

POST_MESSAGES = '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]'
NO_COMMENT_ANCESTOR = 'not(ancestor::*[@role="article"][2]) and not(ancestor::*[starts-with(@aria-label,"Comentário de") or starts-with(@aria-label,"Comment by")])'

def post_container(node):
    parents = node.xpath('ancestor::*[@role="article"][1]')
    if parents:
        return parents[0]
    # Current logged-in Facebook omits role=article. Require a unique post
    # message plus its own action controls, never a whole multi-story feed.
    for parent in list(node.xpath('ancestor::*'))[::-1]:
        if parent.tag in ('body', 'html') or len(parent.css(POST_MESSAGES)) != 1:
            continue
        labels = [label.lower() for label in parent.css('[aria-label]::attr(aria-label)').getall()]
        menus = [label for label in labels if 'ações para este post' in label or 'actions for this post' in label]
        if len(menus) == 1 and any(label == 'curtir' or label == 'like' for label in labels) and any('deixe um comentário' in label or 'leave a comment' in label for label in labels):
            return parent
    return None

def labelled_date(value):
    months = {'janeiro':1,'fevereiro':2,'março':3,'abril':4,'maio':5,'junho':6,
              'julho':7,'agosto':8,'setembro':9,'outubro':10,'novembro':11,'dezembro':12}
    match = re.search(r'\b(\d{1,2}) de ([a-zç]+) de (\d{4}) às (\d{1,2}):(\d{2})\b', value.lower())
    if not match or match.group(2) not in months:
        return None
    try:
        return datetime(int(match.group(3)), months[match.group(2)], int(match.group(1)), int(match.group(4)), int(match.group(5)), tzinfo=ZoneInfo('America/Sao_Paulo')).astimezone(timezone.utc).isoformat()
    except ValueError:
        return None

def extract_post_evidence(article):
    if article is None:
        return {}
    # Only counters inside this post are accepted; profile/follower counters
    # and neighbouring posts cannot be attributed to the current story.
    # Exclude nested comment/article bodies so their reaction counters cannot
    # masquerade as engagement for the story.
    text = clean(' '.join(article.xpath(f'.//text()[{NO_COMMENT_ANCESTOR} and not(ancestor::script) and not(ancestor::style)]').getall())).lower()
    metrics = {}
    number = r'(\d+(?:[.,]\d+)*(?:\s*(?:mil|mi|k|m))?)'
    labels = {'likes': r'curtidas?|likes?', 'comments': r'comentários?|comments?',
              'shares': r'compartilhamentos?|shares?', 'views': r'visualizações|views?'}
    action_labels = {
        'likes': r'\b(curtir|curtidas?|likes?|reagir|reações|reactions?)\b',
        'comments': r'\b(deixe um comentário|comentar|comentários?|comments?)\b',
        'shares': r'\b(compartilhar|compartilhamentos?|shares?)\b|envie.*amig',
    }
    # Logged-in Facebook puts numeric counters inside separately labelled
    # action buttons, e.g. aria-label="Curtir" with visible text "85".
    action_seen = set()
    for button in article.xpath(f'.//*[@role="button" or self::button][{NO_COMMENT_ANCESTOR}]'):
        label = clean(button.attrib.get('aria-label', '')).lower()
        visible = clean(button.get_all_text(separator=' ', strip=True)).lower()
        for key, pattern in action_labels.items():
            if key in metrics or key in action_seen or not re.search(pattern, label):
                continue
            action_seen.add(key)
            raw = visible if re.fullmatch(number, visible) else None
            if raw is None:
                match = re.search(number, label)
                raw = match.group(1) if match else None
            if raw is not None:
                count = parse_number(raw)
                if count is not None:
                    metrics[key] = count
    for key, label in labels.items():
        if key in metrics:
            continue
        match = re.search(number + r'\s*(?:' + label + r')\b', text)
        if match:
            count = parse_number(match.group(1))
            if count is not None:
                metrics[key] = count
    result = {'metrics': metrics, 'metricsProvenance': 'public-post-visible-counters'}
    for href in article.xpath(f'.//a[{NO_COMMENT_ANCESTOR}]/@href').getall():
        permalink = post_url(href)
        if permalink:
            result['url'] = permalink
            break
    for value in article.xpath(f'.//time[{NO_COMMENT_ANCESTOR}]/@datetime | .//*[@data-utime][{NO_COMMENT_ANCESTOR}]/@data-utime').getall():
        try:
            date = datetime.fromtimestamp(float(value), timezone.utc) if re.fullmatch(r'\d{10}(?:\.\d+)?', value) else datetime.fromisoformat(value.replace('Z', '+00:00'))
            if date.tzinfo:
                result['publishedAt'] = date.astimezone(timezone.utc).isoformat()
                break
        except (ValueError, OverflowError, OSError):
            pass
    if 'publishedAt' not in result:
        for link in article.xpath(f'.//a[@aria-label][{NO_COMMENT_ANCESTOR}]'):
            date = labelled_date(link.attrib.get('aria-label', ''))
            if date:
                result['publishedAt'] = date
                result['dateConfidence'] = 'explicit-post-label'
                break
    return result


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
        for node in page.css(POST_MESSAGES):
            value = clean(node.get_all_text(separator=" ", strip=True))
            value = re.sub(r"\s*(?:Ver mais|See more)\s*$", "", value, flags=re.I).strip()
            if usable(value[:240]) and not any(t.get("text") == value for t in topics):
                evidence = {}
                try:
                    evidence = extract_post_evidence(post_container(node))
                except Exception:
                    pass
                topics.append({'text': value[:6000], 'metrics': {}, **evidence})
        topics = sorted(topics, key=lambda x: sum(math.log1p(x['metrics'].get(key, 0)) * weight for key, weight in [('likes', 1), ('comments', 2), ('shares', 1), ('views', .5)]), reverse=True)
        return topics[:40]
    
    texts = []
    selectors = ["//*[self::h1 or self::h2 or self::h3 or self::a]//text()[not(ancestor::script or ancestor::style or ancestor::noscript or ancestor::template)]"]
    for selector in selectors:
        if texts and len(texts) >= 4: break
        for value in page.xpath(selector).getall():
            value = clean(value)
            if usable(value) and not any(t.get("text") == value for t in texts):
                texts.append({"text": value, "metrics": {}})
            if len(texts) >= 40: break
    return texts[:40]

def fetch_page(url, kind):
    from scrapling.fetchers import Fetcher
    if kind == "facebook":
        try:
            from scrapling.fetchers import StealthyFetcher
            options = {'headless': True, 'locale': 'pt-BR', 'timezone_id': 'America/Sao_Paulo'}
            profile = os.environ.get('SCRAPLING_FACEBOOK_PROFILE', '').strip()
            if profile:
                path = Path(profile).resolve()
                path.mkdir(parents=True, exist_ok=True, mode=0o700)
                os.chmod(path, 0o700)
                options['user_data_dir'] = str(path)
            return StealthyFetcher.fetch(url, **options)
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

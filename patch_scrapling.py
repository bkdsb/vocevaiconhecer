import re

with open("scripts/scrapling-sources.py", "r") as f:
    content = f.read()

import_replacement = """import json
import re
from urllib.parse import urljoin, urlparse

def parse_number(num_str):
    num_str = num_str.lower().replace(',', '.').strip()
    multiplier = 1
    if 'k' in num_str or 'mil' in num_str:
        multiplier = 1000
    elif 'm' in num_str or 'mi' in num_str:
        multiplier = 1000000
    num_str = re.sub(r'[^0-9\.]', '', num_str)
    try:
        return int(float(num_str) * multiplier)
    except:
        return 0
"""
content = content.replace("import json\nimport re\nfrom urllib.parse import urljoin, urlparse", import_replacement)


extract_replacement = """def extract_topics(page, kind):
    if kind == "facebook":
        topics = []
        for node in page.css('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-testid="post_message"]'):
            value = clean(node.get_all_text(separator=" ", strip=True))
            value = re.sub(r"\\s*(?:Ver mais|See more)\\s*$", "", value, flags=re.I).strip()
            if len(value) > 240:
                value = value[:237].rsplit(" ", 1)[0] + "…"
            
            if usable(value) and not any(t.get("text") == value for t in topics):
                # Tentar extrair engajamento subindo para o container do post
                score = 0
                views = 0
                likes = 0
                comments = 0
                
                try:
                    # Um fallback simples: procurar números perto do node
                    parent = node.xpath('ancestor::div[@role="article" or @data-ad-comet-preview="message" or contains(@class, "x1yztbdb")][1]')
                    if parent:
                        full_text = parent[0].get_all_text(separator=" ", strip=True).lower()
                        
                        likes_match = re.search(r"([0-9]+[\\.,]?[0-9]*[km]?|\\b[0-9]+)\\s*(curtidas?|likes?)", full_text)
                        if likes_match: likes = parse_number(likes_match.group(1))
                        
                        comments_match = re.search(r"([0-9]+[\\.,]?[0-9]*[km]?|\\b[0-9]+)\\s*(comentários?|comments?)", full_text)
                        if comments_match: comments = parse_number(comments_match.group(1))
                        
                        views_match = re.search(r"([0-9]+[\\.,]?[0-9]*[km]?|\\b[0-9]+)\\s*(visualizações|views?)", full_text)
                        if views_match: views = parse_number(views_match.group(1))
                        
                except Exception:
                    pass
                
                # Se não encontrar nada, o rank natural da página (ordem) importa
                base_score = 10000 - (len(topics) * 500)
                score = base_score + likes + (comments * 2) + (views * 3)
                
                topics.append({"text": value, "metrics": {"likes": likes, "comments": comments, "views": views, "score": score}})
        
        # Sort by score highest first
        topics = sorted(topics, key=lambda x: x["metrics"]["score"], reverse=True)
        return topics[:40]
    
    # Non-FB pages fallback
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
    return texts[:40]"""
content = re.sub(r'def extract_topics\(page, kind\):.*?return texts\[:40\]', extract_replacement, content, flags=re.DOTALL)

with open("scripts/scrapling-sources.py", "w") as f:
    f.write(content)

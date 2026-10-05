import importlib.util
from pathlib import Path
import unittest
import tempfile
import json
import os
from unittest.mock import patch

from scrapling.parser import Selector

spec = importlib.util.spec_from_file_location(
    "scrapling_sources", Path(__file__).resolve().parents[1] / "scripts/scrapling-sources.py"
)
sources = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sources)


class SourceExtractionTest(unittest.TestCase):
    def test_facebook_fallback_excludes_bootloader_payloads(self):
        headline = "Pesquisadores encontram uma espécie rara no litoral brasileiro"
        html = f'''<html><body>
          <script>{{"require":[["qplTimingsServerJS",null,null,["tierOne"]]]}}</script>
          <script>Um texto longo dentro de script também não é uma notícia.</script>
          <style>.some-long-class-name {{ background-color: yellow; }}</style>
          <div>www.fatosdesconhecidos.com.br</div>
          <div data-ad-preview="message">{headline}</div><div data-ad-preview="message">{headline}</div>
        </body></html>'''
        self.assertEqual(sources.extract_topics(Selector(html), "facebook"), [{'text': headline, 'metrics': {}}])

    def test_facebook_profiles_without_post_bodies_are_not_inspiration(self):
        html = '''<body><h2>Fatos Sobrenaturais para você que adora terror</h2>
          <div>Recomendado por 98% (12.064 avaliações)</div>
          <div>Compartilhado com: Público</div>
          <div>Indicador de status online</div></body>'''
        self.assertEqual(sources.extract_topics(Selector(html), "facebook"), [])

    def test_facebook_joins_inline_post_text_without_collecting_the_profile_bio(self):
        html = '''<body><h2>Valorizando a Cultura Nordestina e suas tradições</h2>
          <div data-ad-preview="message"><span>Durante os estudos, Natalia e Brenda</span>
          <span>recebiam a ajuda de seu Rafael, vendedor de empanadas.</span></div></body>'''
        topics = sources.extract_topics(Selector(html), "facebook")
        self.assertEqual(len(topics), 1)
        self.assertIn('Natalia e Brenda recebiam', topics[0]['text'])

    def test_web_headlines_are_retained_without_navigation_or_scripts(self):
        headline = "Novo estudo descreve o comportamento surpreendente de um peixe"
        html = f'''<html><body><h2>{headline}</h2>
          <a>Cadastre seu e-mail para receber notícias</a>
          <h3><script>Texto de script suficientemente longo para parecer uma pauta</script></h3>
        </body></html>'''
        self.assertEqual(sources.extract_topics(Selector(html), "web"), [{'text': headline, 'metrics': {}}])

    def test_counters_permalink_and_date_belong_to_the_same_post(self):
        html = '''<body><div>999999 seguidores</div><div role="article">
          <a href="/Example/posts/123/?tracking=ignored">Post</a>
          <time datetime="2026-10-04T10:00:00-03:00"></time>
          <div data-ad-preview="message">Uma descoberta curiosa sobre os animais do oceano</div>
          <span>1,2 mil curtidas</span><span>34 comentários</span><span>0 compartilhamentos</span>
        </div><div role="article"><span>999 comentários</span></div></body>'''
        post = sources.extract_topics(Selector(html), 'facebook')[0]
        self.assertEqual(post['metrics'], {'likes': 1200, 'comments': 34, 'shares': 0})
        self.assertEqual(post['url'], 'https://www.facebook.com/Example/posts/123/')
        self.assertEqual(post['publishedAt'], '2026-10-04T13:00:00+00:00')
        self.assertNotIn('score', post['metrics'])

    def test_absent_counters_are_unknown_and_profile_links_are_not_posts(self):
        html = '''<div role="article"><a href="/Example">Página</a>
          <div data-ad-preview="message">Uma descoberta curiosa sobre os animais do oceano</div></div>'''
        post = sources.extract_topics(Selector(html), 'facebook')[0]
        self.assertEqual(post['metrics'], {})
        self.assertNotIn('url', post)
        self.assertNotIn('publishedAt', post)
        self.assertIsNone(sources.post_url('https://other.test/posts/123'))
        self.assertIsNone(sources.post_url('/Example/posts/123/?comment_id=12'))

    def test_counter_abbreviations_and_thousand_separators(self):
        for value, expected in [('1,2 mil', 1200), ('1.234', 1234), ('2,000', 2000), ('1.5m', 1500000), ('0', 0)]:
            self.assertEqual(sources.parse_number(value), expected)

    def test_logged_in_action_buttons_have_post_metrics_without_comment_reactions(self):
        html = '''<div role="article"><a href="/Example/posts/123">Post</a>
          <div data-ad-preview="message">Uma descoberta curiosa sobre os animais do oceano</div>
          <div role="button" aria-label="Curtir"><span>85</span></div>
          <div role="button" aria-label="Deixe um comentário"><span>8</span></div>
          <div role="button" aria-label="Envie isso para amigos ou publique na sua linha do tempo."><span>1</span></div>
          <div role="article"><span>9999 curtidas</span><span>999 comentários</span>
            <div role="button" aria-label="9999 Curtir">9999</div></div>
        </div>'''
        post = sources.extract_topics(Selector(html), 'facebook')[0]
        self.assertEqual(post['metrics'], {'likes': 85, 'comments': 8, 'shares': 1})

    def test_first_action_button_without_counter_does_not_take_later_comment_counter(self):
        html = '''<div role="article"><div data-ad-preview="message">Uma descoberta curiosa sobre os animais do oceano</div>
          <div role="button" aria-label="Curtir">Curtir</div>
          <div role="button" aria-label="Deixe um comentário">8</div>
          <div role="button" aria-label="Compartilhar">1</div>
          <div role="button" aria-label="50 Curtir">50</div>
        </div>'''
        self.assertEqual(sources.extract_topics(Selector(html), 'facebook')[0]['metrics'], {'comments': 8, 'shares': 1})

    def test_nested_comment_permalink_and_date_are_not_story_evidence(self):
        html = '''<div role="article"><div data-ad-preview="message">Uma descoberta curiosa sobre os animais do oceano</div>
          <div role="article"><a href="/Other/posts/123">Outra história</a>
            <time datetime="2026-10-04T10:00:00-03:00"></time></div></div>'''
        post = sources.extract_topics(Selector(html), 'facebook')[0]
        self.assertNotIn('url', post)
        self.assertNotIn('publishedAt', post)

    def test_logged_in_post_without_article_role_is_scoped_to_unique_message_and_actions(self):
        html = '''<body><div><div>
          <div role="button" aria-label="Ações para este post de Exemplo"></div>
          <a href="/Example/posts/123" aria-label="Domingo, 4 de outubro de 2026 às 17:30">20 min</a>
          <div><div data-ad-preview="message">Uma descoberta curiosa sobre os animais do oceano</div></div>
          <div role="button" aria-label="Curtir">143</div>
          <div role="button" aria-label="Deixe um comentário">21</div>
          <div role="button" aria-label="Envie para seus amigos ou poste no seu perfil.">3</div>
          <div aria-label="Comentário de Outra pessoa Há 10 minutos">
            <span>9999 curtidas</span><a aria-label="Domingo, 4 de outubro de 2026 às 17:40" href="/Other/posts/999">10 min</a>
          </div>
          </div><div data-ad-preview="message">Outra descoberta curiosa sobre os animais do oceano</div></div></body>'''
        post = sources.extract_topics(Selector(html), 'facebook')[0]
        self.assertEqual(post['metrics'], {'likes': 143, 'comments': 21, 'shares': 3})
        self.assertEqual(post['url'], 'https://www.facebook.com/Example/posts/123')
        self.assertEqual(post['publishedAt'], '2026-10-04T20:30:00+00:00')
        self.assertEqual(post['dateConfidence'], 'explicit-post-label')

    def test_comment_dates_do_not_make_an_undated_story_recent(self):
        html = '''<div role="article"><div data-ad-preview="message">Uma descoberta curiosa sobre os animais do oceano</div>
          <div aria-label="Comentário de Outra pessoa Há 10 minutos">
            <time datetime="2026-10-04T17:40:00-03:00"></time>
            <a aria-label="Domingo, 4 de outubro de 2026 às 17:40" href="/Other/posts/999">10 min</a>
          </div></div>'''
        post = sources.extract_topics(Selector(html), 'facebook')[0]
        self.assertNotIn('publishedAt', post)
        self.assertNotIn('url', post)

    def test_multiple_unscoped_messages_never_share_counters(self):
        html = '''<div><div role="button" aria-label="Ações para este post de Exemplo"></div>
          <div data-ad-preview="message">Uma descoberta curiosa sobre os animais do oceano</div>
          <div data-ad-preview="message">Outra descoberta curiosa sobre os animais do oceano</div>
          <div role="button" aria-label="Curtir">143</div>
          <div role="button" aria-label="Deixe um comentário">21</div></div>'''
        posts = sources.extract_topics(Selector(html), 'facebook')
        self.assertEqual([post['metrics'] for post in posts], [{}, {}])

    def test_dedicated_profile_passed_to_browser_without_importing_other_sessions(self):
        from scrapling.fetchers import StealthyFetcher
        with tempfile.TemporaryDirectory() as directory:
            profile = str(Path(directory) / 'facebook-browser')
            with patch.dict(os.environ, {'SCRAPLING_FACEBOOK_PROFILE': profile}), patch.object(StealthyFetcher, 'fetch', return_value='response') as fetch:
                self.assertEqual(sources.fetch_page('https://www.facebook.com/Example', 'facebook'), 'response')
                options = fetch.call_args.kwargs
                self.assertEqual(options['user_data_dir'], str(Path(profile).resolve()))
                self.assertEqual(options['headless'], True)
                self.assertNotIn('cookies', options)
                self.assertEqual(os.stat(profile).st_mode & 0o777, 0o700)

    def test_session_status_is_atomic_private_and_contains_no_authentication_values(self):
        spec = importlib.util.spec_from_file_location('connect_facebook', Path(__file__).resolve().parents[1] / 'scripts/connect-facebook.py')
        connector = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(connector)
        with tempfile.TemporaryDirectory() as directory:
            status = Path(directory) / 'facebook-session-status.json'
            with patch('builtins.print'):
                connector.session_status(status, True, 'connected')
            result = json.loads(status.read_text())
            self.assertTrue(result['connected'])
            self.assertEqual(set(result), {'connected', 'state', 'updatedAt'})
            self.assertEqual(os.stat(status).st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()

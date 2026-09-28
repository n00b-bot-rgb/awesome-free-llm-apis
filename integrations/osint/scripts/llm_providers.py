"""Explicit provider selection; no automatic evidence upload or provider fallback.
Catalog entries describe upstream claims, not verified free-tier entitlements.
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / 'vendor/awesome-free-llm-apis'
# Exact catalog name -> environment variable, protocol, anonymous availability.
ROUTES = {
    'Aion Labs': ('AION_API_KEY', 'openai', False),
    'Cohere': ('COHERE_API_KEY', 'cohere', False),
    'Google Gemini': ('GEMINI_API_KEY', 'gemini', False),
    'Mistral AI': ('MISTRAL_API_KEY', 'openai', False),
    'Z AI (Zhipu AI)': ('ZAI_API_KEY', 'openai', False),
    'Cloudflare Workers AI': ('CF_API_TOKEN', 'cloudflare', False),
    'Groq': ('GROQ_API_KEY', 'openai', False),
    'Hugging Face': ('HF_API_KEY', 'openai', False),
    'Kilo Code': ('KILO_API_KEY', 'openai', True),
    'LLM7.io': ('LLM7_API_KEY', 'openai', True),
    'ModelScope': ('MODELSCOPE_API_KEY', 'openai', False),
    'NVIDIA NIM': ('NVIDIA_API_KEY', 'openai', False),
    'Ollama Cloud': ('OLLAMA_API_KEY', 'ollama', False),
    'OpenRouter': ('OPENROUTER_API_KEY', 'openai', False),
    'OVHcloud AI Endpoints': ('OVH_API_KEY', 'openai', True),
    'SiliconFlow': ('SILICONFLOW_API_KEY', 'openai', False),
}


def catalog():
    raw = (VENDOR / 'data.json').read_bytes()
    expected = (VENDOR / 'SHA256.txt').read_text().split()[0]
    if hashlib.sha256(raw).hexdigest() != expected:
        raise ValueError('Catalog checksum mismatch; review and pin the update')
    data = json.loads(raw)
    names = [p['name'] for p in data['providers']]
    if len(names) != len(set(names)) or set(names) != set(ROUTES):
        raise ValueError('Catalog provider set does not match supported routes')
    for p in data['providers']:
        u = urllib.parse.urlsplit(p['baseUrl'])
        if u.scheme != 'https' or not u.hostname or u.username or u.password:
            raise ValueError('Invalid catalog endpoint')
        ids = [m['id'] for m in p['models'] if m['id'] is not None]
        if len(ids) != len(set(ids)) or not all(isinstance(m, str) and m for m in ids):
            raise ValueError('Invalid or duplicate model IDs')
    return data


def credentials(provider, env=None):
    env = os.environ if env is None else env
    key_name, protocol, anonymous = ROUTES[provider['name']]
    missing = [] if anonymous or env.get(key_name) else [key_name]
    if protocol == 'cloudflare' and not env.get('CF_ACCOUNT_ID'):
        missing.append('CF_ACCOUNT_ID')
    return missing


def request_for(provider, model, prompt, env=None, max_tokens=64):
    env = os.environ if env is None else env
    key_name, protocol, anonymous = ROUTES[provider['name']]
    if model not in [m['id'] for m in provider['models'] if m['id'] is not None]:
        raise ValueError('Select an exact model ID from the pinned catalog')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 100000:
        raise ValueError('Prompt must contain 1–100000 characters')
    if not 1 <= max_tokens <= 4096:
        raise ValueError('max_tokens must be between 1 and 4096')
    missing = credentials(provider, env)
    if missing:
        raise ValueError('Missing configuration: ' + ', '.join(missing))
    endpoint = provider['baseUrl'].rstrip('/')
    body = {'model': model, 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': max_tokens}
    if protocol == 'gemini':
        endpoint += '/openai/chat/completions'
    elif protocol == 'cohere':
        endpoint += '/chat'
    elif protocol == 'cloudflare':
        account = env['CF_ACCOUNT_ID']
        if not re.fullmatch(r'[a-zA-Z0-9_-]+', account):
            raise ValueError('Invalid CF_ACCOUNT_ID')
        endpoint = endpoint.replace('{account_id}', account) + '/' + model
        body.pop('model')
    elif protocol == 'ollama':
        endpoint += '/chat'
        body.pop('max_tokens')
        body.update(stream=False, options={'num_predict': max_tokens})
    else:
        endpoint += '/chat/completions'
    headers = {'Content-Type': 'application/json', 'User-Agent': 'osint-provider-adapter/1.0'}
    if env.get(key_name):
        headers['Authorization'] = 'Bearer ' + env[key_name]
    return urllib.request.Request(endpoint, data=json.dumps(body).encode(), headers=headers, method='POST')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward credentials to a redirected endpoint.


def extract_text(payload, protocol):
    if protocol == 'cohere':
        parts = payload.get('message', {}).get('content', [])
        text = ''.join(p.get('text', '') for p in parts if isinstance(p, dict))
    elif protocol == 'cloudflare':
        text = payload.get('result', {}).get('response') if payload.get('success') is True else None
    elif protocol == 'ollama':
        text = payload.get('message', {}).get('content')
    else:
        choices = payload.get('choices', [])
        text = choices[0].get('message', {}).get('content') if choices else None
    if not isinstance(text, str) or not text.strip():
        raise ValueError('Response contains no completion text')
    return text


def complete(provider, model, prompt, *, timeout=30, env=None):
    req = request_for(provider, model, prompt, env)
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(req, timeout=timeout) as response:
        raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise ValueError('Response exceeds size limit')
        return extract_text(json.loads(raw), ROUTES[provider['name']][1])


def probe(provider):
    models = [m['id'] for m in provider['models'] if m['id'] is not None]
    model = 'minimax-m2.7' if provider['name'] == 'LLM7.io' else models[0]
    result = {'provider': provider['name'], 'model': model, 'tested_at': datetime.now(timezone.utc).isoformat()}
    missing = credentials(provider)
    if missing:
        return dict(result, status='SKIPPED_CREDENTIALS', missing=missing)
    try:
        complete(provider, model, 'Reply with OK. This is a synthetic connectivity test.')
        return dict(result, status='PASS', http_status=200)
    except urllib.error.HTTPError as exc:
        return dict(result, status='HTTP_ERROR', http_status=exc.code)
    except (urllib.error.URLError, TimeoutError, OSError):
        return dict(result, status='NETWORK_ERROR')
    except (ValueError, KeyError, TypeError, AttributeError, IndexError):
        return dict(result, status='INVALID_RESPONSE')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['list', 'check', 'probe', 'chat'])
    parser.add_argument('--provider', choices=sorted(ROUTES))
    parser.add_argument('--model')
    parser.add_argument('--prompt-file', type=Path)
    parser.add_argument('--public-data', action='store_true', help='Explicitly attest prompt is public/non-sensitive')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    data = catalog()
    providers = [p for p in data['providers'] if not args.provider or p['name'] == args.provider]
    if args.command == 'chat':
        if not args.provider or not args.model or not args.prompt_file or not args.public_data:
            parser.error('chat requires --provider, --model, --prompt-file and --public-data')
        try:
            result = {'provider': args.provider, 'model': args.model,
                      'text': complete(providers[0], args.model, args.prompt_file.read_text()),
                      'validation_state': 'ai_generated_unverified'}
        except urllib.error.HTTPError as exc:
            parser.exit(1, f'Provider returned HTTP {exc.code}; response body omitted\n')
        except (urllib.error.URLError, TimeoutError, OSError):
            parser.exit(1, 'Provider connection or file read failed\n')
        except (ValueError, KeyError, TypeError, AttributeError, IndexError):
            parser.exit(1, 'Configuration or response validation failed\n')
    elif args.command == 'probe':
        with ThreadPoolExecutor(max_workers=3) as executor:
            result = {'scope': 'one model per provider; synthetic prompt only',
                      'results': list(executor.map(probe, providers))}
    else:
        result = {'catalog_updated': data['lastUpdated'], 'source_commit': (VENDOR / 'UPSTREAM_COMMIT.txt').read_text().strip(),
                  'providers': [{'name': p['name'], 'model_ids': [m['id'] for m in p['models'] if m['id'] is not None],
                                 'missing_credentials': credentials(p), 'availability': 'unverified'} for p in providers]}
    encoded = json.dumps(result, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    else:
        print(encoded, end='')
    if args.command == 'probe' and any(r['status'] != 'PASS' for r in result['results']):
        return 2  # An incomplete probe must never imply full success.
    return 0


if __name__ == '__main__':
    sys.exit(main())

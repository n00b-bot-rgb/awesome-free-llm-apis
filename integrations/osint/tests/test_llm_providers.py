import importlib.util
import json
from pathlib import Path
import urllib.error
from unittest.mock import patch
import pytest

MODULE = Path(__file__).resolve().parents[1] / 'scripts/llm_providers.py'
spec = importlib.util.spec_from_file_location('llm_providers', MODULE)
llm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(llm)
PROVIDERS = llm.catalog()['providers']

@pytest.mark.parametrize('provider', PROVIDERS, ids=lambda p:p['name'])
def test_all_catalog_models_build(provider):
    key, protocol, anonymous = llm.ROUTES[provider['name']]
    env = {key:'test-secret', 'CF_ACCOUNT_ID':'testaccount'}
    for model in provider['models']:
        if model['id'] is None:
            continue
        request = llm.request_for(provider, model['id'], 'Synthetic', env)
        body = json.loads(request.data)
        assert request.full_url.startswith('https://')
        assert request.get_header('Authorization') == 'Bearer test-secret'
        assert body['messages'][0]['content'] == 'Synthetic'
        if protocol == 'gemini':
            assert '/v1beta/openai/chat/completions' in request.full_url
        elif protocol == 'cloudflare':
            assert '/accounts/testaccount/ai/run/' in request.full_url
            assert 'model' not in body
        elif protocol == 'ollama':
            assert request.full_url.endswith('/api/chat')
            assert body['stream'] is False
            assert body['options']['num_predict'] == 64
        else:
            assert body['max_tokens'] == 64

@pytest.mark.parametrize('provider', PROVIDERS, ids=lambda p:p['name'])
def test_missing_credentials_fail_closed(provider):
    if llm.ROUTES[provider['name']][2]:
        assert llm.credentials(provider,{}) == []
    else:
        with pytest.raises(ValueError,match='Missing configuration'):
            llm.request_for(provider,provider['models'][0]['id'],'Synthetic',{})

@pytest.mark.parametrize('payload,protocol,expected',[
    ({'choices':[{'message':{'content':'OK'}}]},'openai','OK'),
    ({'message':{'content':[{'type':'text','text':'OK'}]}},'cohere','OK'),
    ({'success':True,'result':{'response':'OK'}},'cloudflare','OK'),
    ({'message':{'content':'OK'}},'ollama','OK'),
])
def test_native_response_parsing(payload,protocol,expected):
    assert llm.extract_text(payload,protocol)==expected

@pytest.mark.parametrize('payload',[{}, {'choices':[]},{'choices':[{'message':{'content':None}}]}])
def test_http_200_is_not_sufficient(payload):
    with pytest.raises(ValueError):
        llm.extract_text(payload,'openai')

def test_cloudflare_error_is_not_completion():
    with pytest.raises(ValueError):
        llm.extract_text({'success':False,'result':{'response':'OK'}},'cloudflare')

def test_no_redirect():
    assert llm.NoRedirect().redirect_request(None,None,302,'',{},'https://elsewhere.invalid') is None

def test_unknown_model_rejected():
    with pytest.raises(ValueError,match='exact model'):
        llm.request_for(PROVIDERS[0],'invented','Synthetic',{})

def test_live_probe_preserves_failure_without_body():
    provider=next(p for p in PROVIDERS if p['name']=='LLM7.io')
    with patch.object(llm,'complete',side_effect=urllib.error.HTTPError('https://x',403,'secret-body',{},None)):
        result=llm.probe(provider)
    assert result['status']=='HTTP_ERROR'
    assert 'secret-body' not in json.dumps(result)

def test_chat_requires_explicit_public_data():
    with pytest.raises(SystemExit) as exc:
        llm.main(['chat'])
    assert exc.value.code==2

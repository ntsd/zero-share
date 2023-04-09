from collections import defaultdict
import requests

# ref: https://github.com/pradt2/always-online-stun
url = 'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt'

def fetch_data_and_parse():
    response = requests.get(url)
    
    if response.status_code == 200:
        raw_data = response.text
        parsed_data = raw_data.strip().split('\n')
        return parsed_data
    else:
        raise Exception(f'Error fetching data: {response.status_code}')

try:
    stun_servers = fetch_data_and_parse()

    providers = defaultdict(list)

    for stun in stun_servers:
       host, port = stun.split(':')
       parts = host.split('.')
       server = '.'.join(parts[1:])
       providers[server].append(stun)

    sorted_providers = dict(sorted(providers.items(), key=lambda x: len(x[1])))
    print(sorted_providers)

except Exception as e:
    print(str(e))

import os

# Hardcoded credentials — triggers CRITICAL
password = "supersecret123"
api_key = "sk-abc123xyz"

# SQL injection — triggers CRITICAL
def get_user(user_id):
    query = "SELECT * FROM users WHERE id = " + user_id
    return query

# Broad exception swallowing — triggers HIGH
def do_something():
    try:
        x = 1/0
    except:
        pass
#test
#another test
##another new test
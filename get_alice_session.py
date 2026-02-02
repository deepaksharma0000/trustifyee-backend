from alice_blue import AliceBlue
import logging

# optional: logs dekhne ke liye
logging.basicConfig(level=logging.DEBUG)


USERNAME   = "1397229"            # tumhara client id
PASSWORD   = "Devidas@09"
TWO_FA     = "732355"           # YOB / PIN / TOTP (account setup pe depend)
APP_ID     = "1397229"      # Apps → API Key page pe "App Code"
API_SECRET = "8IVUcT8ePTfdoiOarsC6Xhh6GyR2TQvv0zbbNkqY1G7Xqe9yzqq8yjJnB9QxIVB0Mcenlii3bULGujbtqIEiUNZytQ1GloFXAI3fqVVdbMS5e93Q4oi5xNq3Abtcmieb"    # Wahi long secret jo tumne .env me dala


if __name__ == "__main__":
    session_id = AliceBlue.login_and_get_sessionID(
        username   = USERNAME,
        password   = PASSWORD,
        twoFA      = TWO_FA,
        app_id     = APP_ID,
        api_secret = API_SECRET
    )
    print("SESSION_ID:", session_id)


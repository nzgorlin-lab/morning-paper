from datetime import date


def greet():
    today = date.today().strftime("%A, %B %d %Y")
    print(f"Good morning. Today is {today}.")
    print("Your morning paper is ready.")


if __name__ == "__main__":
    greet()

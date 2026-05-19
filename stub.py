import time
import tkinter as tk

root = tk.Tk()
root.title("Game Running")

label = tk.Label(root, text="Discord Quest is running...")
label.pack()

def loop():
    root.after(1000, loop)

loop()
root.mainloop()